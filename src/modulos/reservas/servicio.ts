// Reservas: disponibilidad (T3.2) y creacion de citas (T3.3).
// Disponibilidad (RES-03, RES-04, RN-04 a RN-07, RN-10, RN-23, RN-26, RN-34, D-31, D-33, SEG-02):
// algoritmo de la skill disponibilidad-horarios (§8.6). Solo lee: no crea, cambia ni borra nada.
// RNF-01: tres consultas de validacion en paralelo y tres de datos (horarios, bloqueos y citas del
// rango para todos los candidatos); el resto se calcula en memoria, nunca una consulta por dia o barbero.
// Creacion (RES-06, RN-01 a RN-12, RN-34, PO-01 a PO-05, D-19): patron de la skill
// reservas-concurrencia y orden de §8.5, con el mismo calculo de jornada, bloqueos y citas.
import { DateTime, IANAZone } from 'luxon';

import { baseDatos } from '../../compartido/base-datos';
import { esquemaUuid, MAXIMO_DIAS_DISPONIBILIDAD } from '../../compartido/contrato';
import { ErrorNegocio } from '../../compartido/errores';
import { esCruceDeCitas, esDuplicado, esReintentable } from '../../compartido/errores-base-datos';
import { ahora } from '../../compartido/reloj';
import { urlPublicaArchivo } from '../../compartido/urls-archivos';
import { Prisma } from '../../generado/prisma/client';
import type {
  Cita,
  ConsultaDiasDisponibles,
  ConsultaDisponibilidad,
  DiaDisponible,
  Disponibilidad,
  EntradaCrearCita,
} from './esquemas';

// Consultas fuera (baseDatos) o dentro de una transaccion (tx).
type ClienteBaseDatos = typeof baseDatos | Prisma.TransactionClient;

const MS_MINUTO = 60_000;
const MINUTOS_BLOQUE = 15; // RN-10, D5: inicios en horas de reloj locales (:00, :15, :30, :45)
const BLOQUES_POR_DIA = (24 * 60) / MINUTOS_BLOQUE;
// Ninguna cita dura mas de un dia (el horario es de un solo dia): acota la lectura por iniciaEn
// para aprovechar el indice (perfilBarberoId, iniciaEn, estado).
const MS_DIA = 24 * 60 * MS_MINUTO;

// Instantes en milisegundos UTC; intervalo semiabierto [inicio, fin) (RN-04).
interface Intervalo {
  inicio: number;
  fin: number;
}

interface Horario {
  horaApertura: string;
  horaCierre: string;
  inicioPausa: string | null;
  finPausa: string | null;
}

interface Barberia {
  id: string;
  zonaHoraria: string;
  minutosMinAnticipacion: number;
  diasMaxAnticipacion: number;
  maxCitasActivas: number;
  anticipoActivo: boolean;
}

interface Preparacion {
  barberia: Barberia;
  servicioId: string;
  duracionMinutos: number;
  duracionMs: number;
  precio: Prisma.Decimal;
  // Ids de PerfilBarbero ordenados ascendentes (orden de bloqueo, skill reservas-concurrencia).
  candidatos: string[];
}

const noEncontrado = (mensaje: string) => new ErrorNegocio('NO_ENCONTRADO', 404, mensaje);

// El id de la ruta que no es UUID responde NO_ENCONTRADO (no DATOS_INVALIDOS), como en barberias.
function idBarberia(id: string): string {
  const resultado = esquemaUuid.safeParse(id);
  if (!resultado.success) throw noEncontrado('No encontramos esa barbería');
  return resultado.data.toLowerCase();
}

// Valida barberia, servicio y barbero y devuelve los candidatos (ids de PerfilBarbero).
// Orden (README): NO_ENCONTRADO → RECURSO_INACTIVO → SERVICIO_NO_OFRECIDO.
// - Barberia inexistente, inactiva o no publicada: NO_ENCONTRADO para todos, miembros incluidos (D7).
// - Servicio o barbero de otra barberia o inexistente, barbero con Usuario inactivo (D-33) o con
//   membresia INVITADO (nunca fue publico): NO_ENCONTRADO.
// - Servicio inactivo, o barbero con membresia INACTIVO: RECURSO_INACTIVO.
// - Barbero de la barberia que no ofrece el servicio: SERVICIO_NO_OFRECIDO (RN-23).
// Sin barberoId (Cualquiera disponible): membresia ACTIVO, Usuario activo y que ofrezcan el servicio.
// POST /citas la llama dos veces: antes de la transaccion (candidatos a bloquear) y dentro, con tx,
// tras los FOR UPDATE, para validar con lecturas actuales (skill reservas-concurrencia).
async function preparar(
  cliente: ClienteBaseDatos,
  id: string,
  consulta: { servicioId: string; barberoId?: string | undefined },
): Promise<Preparacion> {
  const barberiaId = idBarberia(id);
  const { servicioId, barberoId } = consulta;
  const leerBarberia = () =>
    cliente.barberia.findFirst({
      where: { id: barberiaId, activo: true, publicada: true },
      select: {
        id: true,
        zonaHoraria: true,
        minutosMinAnticipacion: true,
        diasMaxAnticipacion: true,
        maxCitasActivas: true,
        anticipoActivo: true,
      },
    });
  const leerServicio = () =>
    cliente.servicio.findFirst({
      where: { id: servicioId, barberiaId },
      select: { id: true, activo: true, duracionMinutos: true, precio: true },
    });
  const leerBarbero = () =>
    barberoId === undefined
      ? Promise.resolve(null)
      : cliente.perfilBarbero.findFirst({
          where: {
            id: barberoId,
            barberiaId,
            membresia: { barberiaId, estado: { not: 'INVITADO' }, usuario: { activo: true } },
          },
          select: {
            id: true,
            membresia: { select: { estado: true } },
            servicios: { where: { servicioId }, select: { servicioId: true } },
          },
        });
  const leerPerfiles = () =>
    barberoId !== undefined
      ? Promise.resolve(null)
      : cliente.perfilBarbero.findMany({
          where: {
            barberiaId,
            membresia: { barberiaId, estado: 'ACTIVO', usuario: { activo: true } },
            servicios: { some: { servicioId, barberiaId } },
          },
          orderBy: { id: 'asc' },
          select: { id: true },
        });
  // En paralelo fuera de una transaccion (RNF-01); dentro, una tras otra en su conexion.
  const [barberia, servicio, barbero, perfiles] =
    cliente === baseDatos
      ? await Promise.all([leerBarberia(), leerServicio(), leerBarbero(), leerPerfiles()])
      : [await leerBarberia(), await leerServicio(), await leerBarbero(), await leerPerfiles()];

  if (!barberia) throw noEncontrado('No encontramos esa barbería');
  if (!servicio) throw noEncontrado('No encontramos ese servicio');
  if (barberoId !== undefined && !barbero) throw noEncontrado('No encontramos ese barbero');
  if (!servicio.activo) {
    throw new ErrorNegocio('RECURSO_INACTIVO', 409, 'Ese servicio ya no está disponible');
  }
  if (barbero && barbero.membresia.estado !== 'ACTIVO') {
    throw new ErrorNegocio('RECURSO_INACTIVO', 409, 'Ese barbero ya no está disponible');
  }
  if (barbero && barbero.servicios.length === 0) {
    throw new ErrorNegocio('SERVICIO_NO_OFRECIDO', 422, 'Ese barbero no ofrece el servicio');
  }
  if (!IANAZone.isValidZone(barberia.zonaHoraria)) {
    // Dato interno corrupto: 500 INTERNO, el detalle va al log.
    throw new Error(`Zona horaria no valida en la barberia ${barberia.id}`);
  }

  const candidatos = barbero ? [barbero.id] : (perfiles ?? []).map((perfil) => perfil.id);
  return {
    barberia,
    servicioId: servicio.id,
    duracionMinutos: servicio.duracionMinutos,
    duracionMs: servicio.duracionMinutos * MS_MINUTO,
    precio: servicio.precio,
    candidatos: candidatos.sort(),
  };
}

// Horarios, bloqueos y citas activas de los candidatos que pueden tocar [inicio, fin).
interface DatosRango {
  horarioGeneral: Map<number, Horario>;
  horarioPropio: Map<string, Map<number, Horario>>;
  bloqueosGenerales: Intervalo[];
  bloqueosPropios: Map<string, Intervalo[]>;
  citasPropias: Map<string, Intervalo[]>;
}

// Cita que ocupa: CONFIRMADA, o PENDIENTE cuyo anticipoVenceEn no paso (RN-34, §4.7, N4: ocupa
// hasta anticipoVenceEn inclusive). Una PENDIENTE sin anticipoVenceEn (no deberia existir) ocupa.
function filtroCitaActiva(instante: Date) {
  return {
    OR: [
      { estado: 'CONFIRMADA' as const },
      {
        estado: 'PENDIENTE' as const,
        OR: [{ anticipoVenceEn: null }, { anticipoVenceEn: { gte: instante } }],
      },
    ],
  };
}

function agregar<T>(mapa: Map<string, T[]>, clave: string, valor: T): void {
  const lista = mapa.get(clave);
  if (lista) lista.push(valor);
  else mapa.set(clave, [valor]);
}

async function cargarRango(
  cliente: ClienteBaseDatos,
  barberiaId: string,
  candidatos: string[],
  inicio: Date,
  fin: Date,
  instante: Date,
): Promise<DatosRango> {
  // Horario general y bloqueos de toda la barberia (perfilBarberoId nulo) mas los de los candidatos.
  const alcance = [{ perfilBarberoId: null }, { perfilBarberoId: { in: candidatos } }];
  const leerHorarios = () =>
    cliente.horarioAtencion.findMany({
      where: { barberiaId, OR: alcance },
      select: {
        perfilBarberoId: true,
        diaSemana: true,
        horaApertura: true,
        horaCierre: true,
        inicioPausa: true,
        finPausa: true,
      },
    });
  const leerBloqueos = () =>
    cliente.bloqueo.findMany({
      where: { barberiaId, OR: alcance, iniciaEn: { lt: fin }, terminaEn: { gt: inicio } },
      select: { perfilBarberoId: true, iniciaEn: true, terminaEn: true },
    });
  // Una PENDIENTE vencida no ocupa (RN-34, §4.7). La disponibilidad no la cancela (solo lee); POST
  // /citas ya cancelo las de sus candidatos dentro de la transaccion antes de llegar aqui.
  const leerCitas = () =>
    cliente.cita.findMany({
      where: {
        barberiaId,
        perfilBarberoId: { in: candidatos },
        iniciaEn: { gte: new Date(inicio.getTime() - MS_DIA), lt: fin },
        terminaEn: { gt: inicio },
        ...filtroCitaActiva(instante),
      },
      select: { perfilBarberoId: true, iniciaEn: true, terminaEn: true },
    });
  // En paralelo fuera de una transaccion (RNF-01); dentro, una tras otra en su conexion.
  const [horarios, bloqueos, citas] =
    cliente === baseDatos
      ? await Promise.all([leerHorarios(), leerBloqueos(), leerCitas()])
      : [await leerHorarios(), await leerBloqueos(), await leerCitas()];

  const datos: DatosRango = {
    horarioGeneral: new Map(),
    horarioPropio: new Map(),
    bloqueosGenerales: [],
    bloqueosPropios: new Map(),
    citasPropias: new Map(),
  };
  for (const { perfilBarberoId, diaSemana, ...horario } of horarios) {
    if (perfilBarberoId === null) {
      datos.horarioGeneral.set(diaSemana, horario);
    } else {
      const propio = datos.horarioPropio.get(perfilBarberoId) ?? new Map<number, Horario>();
      propio.set(diaSemana, horario);
      datos.horarioPropio.set(perfilBarberoId, propio);
    }
  }
  for (const bloqueo of bloqueos) {
    const intervalo = { inicio: bloqueo.iniciaEn.getTime(), fin: bloqueo.terminaEn.getTime() };
    if (bloqueo.perfilBarberoId === null) datos.bloqueosGenerales.push(intervalo);
    else agregar(datos.bloqueosPropios, bloqueo.perfilBarberoId, intervalo);
  }
  for (const cita of citas) {
    agregar(datos.citasPropias, cita.perfilBarberoId, {
      inicio: cita.iniciaEn.getTime(),
      fin: cita.terminaEn.getTime(),
    });
  }
  return datos;
}

// "HH:mm" local de ese dia como instante UTC.
function instanteLocal(dia: DateTime, hora: string): number {
  const [horas, minutos] = hora.split(':').map(Number);
  return dia.set({ hour: horas, minute: minutos, second: 0, millisecond: 0 }).toMillis();
}

// Tramos libres de base tras restar los ocupados, ordenados y disjuntos.
function restar(base: Intervalo, ocupados: Intervalo[]): Intervalo[] {
  const relevantes = ocupados
    .filter((ocupado) => ocupado.fin > base.inicio && ocupado.inicio < base.fin)
    .sort((a, b) => a.inicio - b.inicio);
  const libres: Intervalo[] = [];
  let cursor = base.inicio;
  for (const ocupado of relevantes) {
    if (ocupado.inicio > cursor) libres.push({ inicio: cursor, fin: ocupado.inicio });
    cursor = Math.max(cursor, ocupado.fin);
    if (cursor >= base.fin) break;
  }
  if (cursor < base.fin) libres.push({ inicio: cursor, fin: base.fin });
  return libres;
}

// Un dia local de la barberia con sus inicios de reloj posibles (D5).
interface DiaLocal {
  fecha: string;
  dia: DateTime;
  diaSemana: number;
  bloques: number[];
}

function diaLocal(dia: DateTime): DiaLocal {
  // Con set y no sumando minutos: en un cambio de hora los bloques siguen siendo horas de reloj.
  const bloques = new Set<number>();
  for (let k = 0; k < BLOQUES_POR_DIA; k += 1) {
    const minutos = k * MINUTOS_BLOQUE;
    bloques.add(dia.set({ hour: Math.floor(minutos / 60), minute: minutos % 60 }).toMillis());
  }
  return {
    fecha: dia.toISODate() ?? '',
    dia,
    diaSemana: dia.weekday % 7, // D5: 0 = domingo (Luxon: 1 lunes a 7 domingo)
    bloques: [...bloques].sort((a, b) => a - b),
  };
}

// Jornada de un barbero en un dia local: su horario recortado al general (RN-05) y las pausas de
// ambos. Sin horario general o sin horario propio ese dia no trabaja (D-31, N1): null.
interface Jornada {
  trabajo: Intervalo;
  pausas: Intervalo[];
}

function jornada(perfilId: string, local: DiaLocal, datos: DatosRango): Jornada | null {
  const general = datos.horarioGeneral.get(local.diaSemana);
  const propio = datos.horarioPropio.get(perfilId)?.get(local.diaSemana);
  if (!general || !propio) return null;

  const trabajo = {
    inicio: Math.max(
      instanteLocal(local.dia, general.horaApertura),
      instanteLocal(local.dia, propio.horaApertura),
    ),
    fin: Math.min(
      instanteLocal(local.dia, general.horaCierre),
      instanteLocal(local.dia, propio.horaCierre),
    ),
  };
  if (!(trabajo.inicio < trabajo.fin)) return null;

  const pausas: Intervalo[] = [];
  for (const horario of [general, propio]) {
    if (horario.inicioPausa !== null && horario.finPausa !== null) {
      pausas.push({
        inicio: instanteLocal(local.dia, horario.inicioPausa),
        fin: instanteLocal(local.dia, horario.finPausa),
      });
    }
  }
  return { trabajo, pausas };
}

// RN-26: bloqueos suyos y de toda la barberia.
function bloqueosDe(perfilId: string, datos: DatosRango): Intervalo[] {
  return [...datos.bloqueosGenerales, ...(datos.bloqueosPropios.get(perfilId) ?? [])];
}

// Inicios libres de un barbero en un dia (pasos 1 a 5 de la skill). Con soloUno para en el primero.
function iniciosDeBarbero(
  perfilId: string,
  local: DiaLocal,
  datos: DatosRango,
  duracionMs: number,
  minimoInicio: number,
  soloUno: boolean,
): number[] {
  const dia = jornada(perfilId, local, datos);
  if (!dia) return [];

  // RN-05: pausas; RN-26: bloqueos; RN-04: citas.
  const ocupados: Intervalo[] = [
    ...dia.pausas,
    ...bloqueosDe(perfilId, datos),
    ...(datos.citasPropias.get(perfilId) ?? []),
  ];
  const libres = restar(dia.trabajo, ocupados);

  // RN-10: cabe la duracion completa; RN-06: no antes de ahora + minutosMinAnticipacion.
  const inicios: number[] = [];
  let tramo = 0;
  for (const bloque of local.bloques) {
    if (bloque < minimoInicio) continue;
    // Tramos ordenados: el que termina antes de bloque + duracion tampoco sirve a los siguientes.
    while (tramo < libres.length && (libres[tramo]?.fin ?? 0) < bloque + duracionMs) tramo += 1;
    const libre = libres[tramo];
    if (!libre) break;
    if (libre.inicio <= bloque) {
      inicios.push(bloque);
      if (soloUno) break;
    }
  }
  return inicios;
}

// RN-06, RN-07, D5: primer inicio permitido y fechas locales de hoy a hoy + diasMaxAnticipacion.
function ventana(barberia: Barberia, instante: Date) {
  const hoy = DateTime.fromJSDate(instante, { zone: barberia.zonaHoraria }).startOf('day');
  return {
    hoyFecha: hoy.toISODate() ?? '',
    ultimaFecha: hoy.plus({ days: barberia.diasMaxAnticipacion }).toISODate() ?? '',
    minimoInicio: instante.getTime() + barberia.minutosMinAnticipacion * MS_MINUTO,
  };
}

// Calcula los dias locales [desde, hasta] (AAAA-MM-DD) en la zona de la barberia. soloUno: para
// /dias basta un inicio por dia. RN-07 y D5: solo de hoy local a hoy + diasMaxAnticipacion.
async function calcular(
  preparacion: Preparacion,
  desde: string,
  hasta: string,
  soloUno: boolean,
): Promise<{ fecha: string; inicios: number[] }[]> {
  const { barberia, duracionMs, candidatos } = preparacion;
  const zona = barberia.zonaHoraria;
  const instante = ahora();
  const { hoyFecha, ultimaFecha, minimoInicio } = ventana(barberia, instante);

  // Acotado tambien por MAXIMO_DIAS_DISPONIBILIDAD: el bucle no depende solo de la validacion.
  const fechas: string[] = [];
  for (
    let dia = DateTime.fromISO(desde, { zone: zona });
    dia.isValid && (dia.toISODate() ?? '') <= hasta && fechas.length < MAXIMO_DIAS_DISPONIBILIDAD;
    dia = dia.plus({ days: 1 })
  ) {
    fechas.push(dia.toISODate() ?? '');
  }

  // Fechas ISO comparables como texto. Fuera de la ventana o sin candidatos no se consulta nada.
  const primera = desde > hoyFecha ? desde : hoyFecha;
  const ultima = hasta < ultimaFecha ? hasta : ultimaFecha;
  if (primera > ultima || candidatos.length === 0) {
    return fechas.map((fecha) => ({ fecha, inicios: [] }));
  }

  const inicioRango = DateTime.fromISO(primera, { zone: zona }).startOf('day');
  const finRango = DateTime.fromISO(ultima, { zone: zona }).plus({ days: 1 }).startOf('day');
  const datos = await cargarRango(
    baseDatos,
    barberia.id,
    candidatos,
    inicioRango.toJSDate(),
    finRango.toJSDate(),
    instante,
  );

  return fechas.map((fecha) => {
    if (fecha < primera || fecha > ultima) return { fecha, inicios: [] };
    const local = diaLocal(DateTime.fromISO(fecha, { zone: zona }).startOf('day'));
    // Cualquiera disponible: union de los candidatos sin repetir inicios.
    const union = new Set<number>();
    for (const perfilId of candidatos) {
      for (const inicio of iniciosDeBarbero(
        perfilId,
        local,
        datos,
        duracionMs,
        minimoInicio,
        soloUno,
      )) {
        union.add(inicio);
      }
      if (soloUno && union.size > 0) break;
    }
    return { fecha, inicios: [...union].sort((a, b) => a - b) };
  });
}

// RES-04: inicios libres de una fecha local, ascendentes en ISO UTC, sin barbero asignado (D1).
export async function disponibilidad(
  id: string,
  consulta: ConsultaDisponibilidad,
): Promise<Disponibilidad> {
  const preparacion = await preparar(baseDatos, id, consulta);
  const [dia] = await calcular(preparacion, consulta.fecha, consulta.fecha, false);
  return {
    fecha: consulta.fecha,
    horarios: (dia?.inicios ?? []).map((inicio) => ({ iniciaEn: new Date(inicio).toISOString() })),
  };
}

// RES-03: un elemento por dia del rango; disponible si conserva al menos un inicio (CU-07).
export async function diasDisponibles(
  id: string,
  consulta: ConsultaDiasDisponibles,
): Promise<DiaDisponible[]> {
  const preparacion = await preparar(baseDatos, id, consulta);
  const dias = await calcular(preparacion, consulta.desde, consulta.hasta, true);
  return dias.map((dia) => ({ fecha: dia.fecha, disponible: dia.inicios.length > 0 }));
}

// ---------------------------------------------------------------------------------------------
// POST /citas (T3.3, RES-06, HU-RES-01, HU-RES-04, RN-01 a RN-12, RN-34, PO-01 a PO-05, D-19).

const MINUTOS_ANTICIPO = 15; // RN-34: la PENDIENTE vence a los 15 minutos de crearse
const MOTIVO_ANTICIPO_VENCIDO = 'Anticipo vencido';
const MAXIMO_REINTENTOS = 2; // skill reservas-concurrencia: P2028, P2034 y 40P01

// Campos de <cita> (D4) con select explicito (RNF-17): nada del cliente ni datos internos.
const SELECCION_CITA = {
  id: true,
  estado: true,
  iniciaEn: true,
  terminaEn: true,
  duracionReserva: true,
  precioReserva: true,
  notas: true,
  anticipoVenceEn: true,
  canceladaEn: true,
  motivoCancelacion: true,
  barberia: {
    select: {
      id: true,
      nombre: true,
      direccion: true,
      telefono: true,
      minutosMinCancelacion: true,
    },
  },
  servicio: { select: { id: true, nombre: true } },
  perfilBarbero: { select: { id: true, nombreVisible: true, archivoFoto: true } },
} satisfies Prisma.CitaSelect;

type FilaCita = Prisma.CitaGetPayload<{ select: typeof SELECCION_CITA }>;

// D4: puedeCancelar si sigue activa y faltan al menos minutosMinCancelacion (RN-13, exacto vale).
function aCita(fila: FilaCita, instante: Date): Cita {
  const activa = fila.estado === 'PENDIENTE' || fila.estado === 'CONFIRMADA';
  const { minutosMinCancelacion, ...barberia } = fila.barberia;
  return {
    id: fila.id,
    estado: fila.estado,
    iniciaEn: fila.iniciaEn.toISOString(),
    terminaEn: fila.terminaEn.toISOString(),
    duracionReserva: fila.duracionReserva,
    precioReserva: fila.precioReserva.toFixed(2),
    notas: fila.notas,
    anticipoVenceEn: fila.anticipoVenceEn?.toISOString() ?? null,
    barberia,
    servicio: fila.servicio,
    barbero: {
      id: fila.perfilBarbero.id,
      nombreVisible: fila.perfilBarbero.nombreVisible,
      urlFoto: urlPublicaArchivo(fila.perfilBarbero.archivoFoto),
    },
    canceladaEn: fila.canceladaEn?.toISOString() ?? null,
    motivoCancelacion: fila.motivoCancelacion,
    puedeCancelar:
      activa && fila.iniciaEn.getTime() - instante.getTime() >= minutosMinCancelacion * MS_MINUTO,
  };
}

// D2: la clave es unica por cliente (@@unique([clienteId, claveIdempotencia])).
function buscarPorClave(cliente: ClienteBaseDatos, clienteId: string, clave: string) {
  return cliente.cita.findFirst({
    where: { clienteId, claveIdempotencia: clave },
    select: SELECCION_CITA,
  });
}

interface Solicitud {
  entrada: EntradaCrearCita;
  clienteId: string;
  clave: string;
  inicio: Date;
  notas: string | null;
}

interface Resultado {
  fila: FilaCita;
  creada: boolean;
  fotosVencidas: string[];
  instante: Date;
}

// Pasos 6 a 8 de §8.5 para un barbero, en ese orden.
type FalloBarbero = 'FUERA_DE_HORARIO' | 'BARBERO_NO_DISPONIBLE' | 'HORARIO_OCUPADO';
const ORDEN_FALLOS: readonly FalloBarbero[] = [
  'FUERA_DE_HORARIO',
  'BARBERO_NO_DISPONIBLE',
  'HORARIO_OCUPADO',
];

const ERRORES_BARBERO: Record<FalloBarbero, () => ErrorNegocio> = {
  FUERA_DE_HORARIO: () =>
    new ErrorNegocio('FUERA_DE_HORARIO', 422, 'Ese horario está fuera de la atención'),
  BARBERO_NO_DISPONIBLE: () =>
    new ErrorNegocio('BARBERO_NO_DISPONIBLE', 409, 'El barbero no atiende en ese horario'),
  HORARIO_OCUPADO: () =>
    new ErrorNegocio('HORARIO_OCUPADO', 409, 'El horario ya no está disponible'),
};

const solapa = (a: Intervalo, b: Intervalo) => a.inicio < b.fin && b.inicio < a.fin;

// Mismo calculo que la disponibilidad (jornada, bloqueos y citas), separando el motivo del fallo.
// null si el barbero puede atender [inicio, fin).
function evaluarBarbero(
  perfilId: string,
  local: DiaLocal,
  datos: DatosRango,
  cita: Intervalo,
): FalloBarbero | null {
  // RN-05: cabe entera en su jornada (recortada a la de la barberia) y no toca las pausas.
  const dia = jornada(perfilId, local, datos);
  if (
    !dia ||
    cita.inicio < dia.trabajo.inicio ||
    cita.fin > dia.trabajo.fin ||
    dia.pausas.some((pausa) => solapa(pausa, cita))
  ) {
    return 'FUERA_DE_HORARIO';
  }
  // RN-26 (D6: tambien el cierre de toda la barberia).
  if (bloqueosDe(perfilId, datos).some((bloqueo) => solapa(bloqueo, cita))) {
    return 'BARBERO_NO_DISPONIBLE';
  }
  // RN-04, RN-11: intervalo semiabierto.
  if ((datos.citasPropias.get(perfilId) ?? []).some((otra) => solapa(otra, cita))) {
    return 'HORARIO_OCUPADO';
  }
  return null;
}

// Paso 5 de §8.5 (RN-06, RN-07, D5), con la misma ventana que la disponibilidad.
function validarFecha(barberia: Barberia, inicio: Date, instante: Date): void {
  const { ultimaFecha, minimoInicio } = ventana(barberia, instante);
  if (inicio.getTime() < instante.getTime()) {
    throw new ErrorNegocio('HORARIO_PASADO', 422, 'Ese horario ya pasó');
  }
  if (inicio.getTime() < minimoInicio) {
    throw new ErrorNegocio(
      'ANTICIPACION_INSUFICIENTE',
      422,
      `Reserva con al menos ${barberia.minutosMinAnticipacion} minutos de anticipación`,
    );
  }
  const fecha = DateTime.fromJSDate(inicio, { zone: barberia.zonaHoraria }).toISODate() ?? '';
  if (fecha > ultimaFecha) {
    throw new ErrorNegocio(
      'FECHA_DEMASIADO_LEJANA',
      422,
      `Solo puedes reservar hasta ${barberia.diasMaxAnticipacion} días adelante`,
    );
  }
}

// Paso 2 de la skill: cancela las PENDIENTE vencidas de los barberos ya bloqueados (RN-34, §8.5),
// porque siguen ocupando ex_citas_barbero_sin_cruce. canceladaPorId nulo = Sistema; auditadas como
// anticipo vencido (§11.7). Devuelve las claves de sus fotos de referencia para borrarlas tras el commit.
async function cancelarVencidas(
  tx: Prisma.TransactionClient,
  barberos: string[],
  instante: Date,
): Promise<string[]> {
  const vencidas = {
    perfilBarberoId: { in: barberos },
    estado: 'PENDIENTE' as const,
    anticipoVenceEn: { lt: instante },
  };
  const filas = await tx.cita.findMany({
    where: vencidas,
    select: { id: true, archivoFotoReferencia: true },
  });
  if (filas.length === 0) return [];
  // Solo las que esta actualizacion cambio (el proceso programado podria cancelarlas a la vez).
  const canceladas = await tx.cita.updateManyAndReturn({
    where: { ...vencidas, id: { in: filas.map((fila) => fila.id) } },
    data: {
      estado: 'CANCELADA',
      canceladaEn: instante,
      motivoCancelacion: MOTIVO_ANTICIPO_VENCIDO,
      archivoFotoReferencia: null,
    },
    select: { id: true, barberiaId: true, anticipoVenceEn: true },
  });
  if (canceladas.length === 0) return [];
  await tx.registroAuditoria.createMany({
    data: canceladas.map((cita) => ({
      barberiaId: cita.barberiaId,
      actorId: null,
      accion: 'ANTICIPO_VENCIDO',
      tipoEntidad: 'Cita',
      entidadId: cita.id,
      antes: { estado: 'PENDIENTE', anticipoVenceEn: cita.anticipoVenceEn?.toISOString() ?? null },
      despues: {
        estado: 'CANCELADA',
        motivoCancelacion: MOTIVO_ANTICIPO_VENCIDO,
        canceladaEn: instante.toISOString(),
      },
    })),
  });
  const ids = new Set(canceladas.map((cita) => cita.id));
  return filas
    .filter((fila) => ids.has(fila.id))
    .flatMap((fila) => (fila.archivoFotoReferencia === null ? [] : [fila.archivoFotoReferencia]));
}

// CU-07 A3: de los candidatos que pueden atender, el de menos citas activas que empiezan ese dia
// local, empate por menor id (candidatos ya ordenados). Activas = las de datos.citasPropias:
// CONFIRMADA y PENDIENTE vigente (filtroCitaActiva); CANCELADA, COMPLETADA, AUSENTE y PENDIENTE
// vencida no cuentan. Si nadie puede, el fallo del candidato que llego mas lejos en el orden de
// §8.5; sin candidatos, HORARIO_OCUPADO.
function elegirBarbero(
  candidatos: string[],
  local: DiaLocal,
  finDia: number,
  datos: DatosRango,
  cita: Intervalo,
): string {
  const inicioDia = local.dia.toMillis();
  let elegido: { id: string; citasActivasDia: number } | null = null;
  let fallo = -1;
  for (const perfilId of candidatos) {
    const resultado = evaluarBarbero(perfilId, local, datos, cita);
    if (resultado !== null) {
      fallo = Math.max(fallo, ORDEN_FALLOS.indexOf(resultado));
      continue;
    }
    const citasActivasDia = (datos.citasPropias.get(perfilId) ?? []).filter(
      (otra) => otra.inicio >= inicioDia && otra.inicio < finDia,
    ).length;
    if (!elegido || citasActivasDia < elegido.citasActivasDia) {
      elegido = { id: perfilId, citasActivasDia };
    }
  }
  if (elegido) return elegido.id;
  throw ERRORES_BARBERO[ORDEN_FALLOS[fallo] ?? 'HORARIO_OCUPADO']();
}

// Paso 9 de §8.5 (RN-08, RN-09, D-09). Ignora las PENDIENTE vencidas del cliente con otros barberos.
async function validarCliente(
  tx: Prisma.TransactionClient,
  barberia: Barberia,
  clienteId: string,
  cita: { iniciaEn: Date; terminaEn: Date },
  instante: Date,
): Promise<void> {
  // RN-08: ninguna otra cita activa suya se solapa, en ninguna barberia.
  const cruce = await tx.cita.findFirst({
    where: {
      clienteId,
      iniciaEn: { lt: cita.terminaEn },
      terminaEn: { gt: cita.iniciaEn },
      ...filtroCitaActiva(instante),
    },
    select: { id: true },
  });
  if (cruce) {
    throw new ErrorNegocio('CRUCE_DEL_CLIENTE', 409, 'Ya tienes una cita en ese horario');
  }
  // RN-09: maximo de citas futuras activas en esta barberia.
  const activas = await tx.cita.count({
    where: {
      clienteId,
      barberiaId: barberia.id,
      iniciaEn: { gte: instante },
      ...filtroCitaActiva(instante),
    },
  });
  if (activas >= barberia.maxCitasActivas) {
    throw new ErrorNegocio(
      'LIMITE_DE_CITAS',
      409,
      `Ya tienes ${barberia.maxCitasActivas} citas activas en esta barbería`,
    );
  }
}

// Todo dentro de una transaccion READ COMMITTED (skill reservas-concurrencia, §8.5).
// bloqueados: candidatos calculados antes de abrir la transaccion (CU-07 A3), ordenados por id.
async function reservarEnTransaccion(
  tx: Prisma.TransactionClient,
  bloqueados: string[],
  solicitud: Solicitud,
): Promise<Resultado> {
  const { entrada, clienteId, clave, inicio } = solicitud;

  // 1. Bloquear a los barberos (uno, o todos los candidatos por id ascendente): primera instruccion.
  for (const perfilId of bloqueados) {
    await tx.$queryRaw`SELECT id FROM perfiles_barbero WHERE id = ${perfilId}::uuid FOR UPDATE`;
  }
  // La hora de las reglas se toma despues de esperar el bloqueo, en cada intento.
  const instante = ahora();
  // 2. Cancelar sus PENDIENTE vencidas (RN-34).
  const fotosVencidas = await cancelarVencidas(tx, bloqueados, instante);
  // 3. Bloquear al cliente, siempre despues de los barberos (sin interbloqueos).
  await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${clienteId}::uuid FOR UPDATE`;

  // D2: otra solicitud con la misma clave pudo terminar mientras esperabamos el bloqueo: 200.
  const repetida = await buscarPorClave(tx, clienteId, clave);
  if (repetida) return { fila: repetida, creada: false, fotosVencidas, instante };

  // 4. Revalidar con lecturas actuales, en el orden de §8.5. Pasos 3 y 4: barberia, servicio y
  // barbero releidos con tx (precio, duracion, anticipo, limites y membresias vigentes). Solo
  // pueden atender los candidatos que siguen siendolo y que ya estan bloqueados.
  const preparacion = await preparar(tx, entrada.barberiaId, entrada);
  const { barberia, duracionMs } = preparacion;
  const bloqueadosSet = new Set(bloqueados);
  const candidatos = preparacion.candidatos.filter((perfilId) => bloqueadosSet.has(perfilId));
  validarFecha(barberia, inicio, instante);
  const cita = { inicio: inicio.getTime(), fin: inicio.getTime() + duracionMs };
  const local = diaLocal(
    DateTime.fromJSDate(inicio, { zone: barberia.zonaHoraria }).startOf('day'),
  );
  const finDia = local.dia.plus({ days: 1 }).startOf('day');
  const datos = await cargarRango(
    tx,
    barberia.id,
    candidatos,
    local.dia.toJSDate(),
    finDia.toJSDate(),
    instante,
  );
  const perfilBarberoId = elegirBarbero(candidatos, local, finDia.toMillis(), datos, cita);
  const terminaEn = new Date(cita.fin);
  await validarCliente(tx, barberia, clienteId, { iniciaEn: inicio, terminaEn }, instante);

  // 5. Insertar con terminaEn, precioReserva y duracionReserva copiados (RN-02, RN-03). RN-12:
  // CONFIRMADA; con anticipo, PENDIENTE hasta ahora + 15 min (RN-34).
  const estado = barberia.anticipoActivo ? 'PENDIENTE' : 'CONFIRMADA';
  const fila = await tx.cita.create({
    data: {
      barberiaId: barberia.id,
      clienteId,
      perfilBarberoId,
      servicioId: preparacion.servicioId,
      iniciaEn: inicio,
      terminaEn,
      precioReserva: preparacion.precio,
      duracionReserva: preparacion.duracionMinutos,
      estado,
      notas: solicitud.notas,
      claveIdempotencia: clave,
      anticipoVenceEn: barberia.anticipoActivo
        ? new Date(instante.getTime() + MINUTOS_ANTICIPO * MS_MINUTO)
        : null,
    },
    select: SELECCION_CITA,
  });

  // CU-07, §11.7: cita creada (usuario, cita, barberia, fecha y hora). Sin las notas del cliente.
  await tx.registroAuditoria.create({
    data: {
      barberiaId: barberia.id,
      actorId: clienteId,
      accion: 'CITA_CREADA',
      tipoEntidad: 'Cita',
      entidadId: fila.id,
      despues: {
        estado,
        perfilBarberoId,
        servicioId: preparacion.servicioId,
        iniciaEn: fila.iniciaEn.toISOString(),
        terminaEn: fila.terminaEn.toISOString(),
        precioReserva: fila.precioReserva.toFixed(2),
        duracionReserva: fila.duracionReserva,
      },
    },
  });

  return { fila, creada: true, fotosVencidas, instante };
}

// Tras el commit se borran las fotos de referencia de las PENDIENTE canceladas (skill
// almacen-archivos). AlmacenArchivos y la foto de referencia (RES-14) aun no existen: hoy ninguna
// cita trae foto. Al implementarlas, borrar aqui cada clave sin bloquear la respuesta.
function eliminarFotosVencidas(claves: string[]): void {
  void claves;
}

export interface CitaCreada {
  cita: Cita;
  // false: la clave de idempotencia ya existia (D2) y se devuelve esa cita con 200.
  creada: boolean;
}

// RES-06. Idempotencia (D2): primero se busca por (clienteId, claveIdempotencia) y, si existe, se
// devuelve sin revalidar (aunque la barberia ya no este publicada o el cuerpo difiera).
export async function crearCita(clienteId: string, entrada: EntradaCrearCita): Promise<CitaCreada> {
  const clave = entrada.claveIdempotencia.toLowerCase();

  const existente = await buscarPorClave(baseDatos, clienteId, clave);
  if (existente) return { cita: aCita(existente, ahora()), creada: false };

  // Candidatos a bloquear (CU-07 A3), antes de abrir la transaccion. Sus errores (pasos 3 y 4 de
  // §8.5) salen aqui sin bloquear a nadie; dentro se vuelven a validar con lecturas actuales.
  const { candidatos } = await preparar(baseDatos, entrada.barberiaId, entrada);
  const solicitud: Solicitud = {
    entrada,
    clienteId,
    clave,
    inicio: new Date(entrada.iniciaEn), // ISO con cualquier desfase, normalizado a UTC
    notas: entrada.notas === undefined || entrada.notas === '' ? null : entrada.notas,
  };

  for (let intento = 0; ; intento += 1) {
    try {
      const resultado = await baseDatos.$transaction(
        (tx) => reservarEnTransaccion(tx, candidatos, solicitud),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: 10_000,
        },
      );
      eliminarFotosVencidas(resultado.fotosVencidas);
      return { cita: aCita(resultado.fila, resultado.instante), creada: resultado.creada };
    } catch (error) {
      // D-19: la restriccion de respaldo vio un cruce que la logica no detecto.
      if (esCruceDeCitas(error)) throw ERRORES_BARBERO.HORARIO_OCUPADO();
      // D2: otra solicitud con la misma clave inserto primero. El unico indice de Cita que puede
      // repetirse es (clienteId, claveIdempotencia): el id lo genera la base.
      if (esDuplicado(error)) {
        const repetida = await buscarPorClave(baseDatos, clienteId, clave);
        if (repetida) return { cita: aCita(repetida, ahora()), creada: false };
        throw error;
      }
      // Tiempo agotado, conflicto o interbloqueo: se repite completa y vera lo ya creado.
      if (esReintentable(error) && intento < MAXIMO_REINTENTOS) continue;
      throw error;
    }
  }
}
