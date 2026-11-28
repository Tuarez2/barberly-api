// Disponibilidad (T3.2, RES-03, RES-04, RN-04 a RN-07, RN-10, RN-23, RN-26, RN-34, D-31, D-33, SEG-02).
// Algoritmo de la skill disponibilidad-horarios (§8.6). Solo lee: no crea, cambia ni borra nada.
// RNF-01: tres consultas de validacion en paralelo y tres de datos (horarios, bloqueos y citas del
// rango para todos los candidatos); el resto se calcula en memoria, nunca una consulta por dia o barbero.
import { DateTime, IANAZone } from 'luxon';

import { baseDatos } from '../../compartido/base-datos';
import { esquemaUuid, MAXIMO_DIAS_DISPONIBILIDAD } from '../../compartido/contrato';
import { ErrorNegocio } from '../../compartido/errores';
import { ahora } from '../../compartido/reloj';
import type {
  ConsultaDiasDisponibles,
  ConsultaDisponibilidad,
  DiaDisponible,
  Disponibilidad,
} from './esquemas';

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
}

interface Preparacion {
  barberia: Barberia;
  duracionMs: number;
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
async function preparar(
  id: string,
  consulta: { servicioId: string; barberoId?: string | undefined },
): Promise<Preparacion> {
  const barberiaId = idBarberia(id);
  const { servicioId, barberoId } = consulta;
  const [barberia, servicio, barbero, perfiles] = await Promise.all([
    baseDatos.barberia.findFirst({
      where: { id: barberiaId, activo: true, publicada: true },
      select: {
        id: true,
        zonaHoraria: true,
        minutosMinAnticipacion: true,
        diasMaxAnticipacion: true,
      },
    }),
    baseDatos.servicio.findFirst({
      where: { id: servicioId, barberiaId },
      select: { activo: true, duracionMinutos: true },
    }),
    barberoId === undefined
      ? null
      : baseDatos.perfilBarbero.findFirst({
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
        }),
    barberoId !== undefined
      ? null
      : baseDatos.perfilBarbero.findMany({
          where: {
            barberiaId,
            membresia: { barberiaId, estado: 'ACTIVO', usuario: { activo: true } },
            servicios: { some: { servicioId, barberiaId } },
          },
          orderBy: { id: 'asc' },
          select: { id: true },
        }),
  ]);

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

  return {
    barberia,
    duracionMs: servicio.duracionMinutos * MS_MINUTO,
    candidatos: barbero ? [barbero.id] : (perfiles ?? []).map((perfil) => perfil.id),
  };
}

// Horarios, bloqueos y citas activas de los candidatos que pueden tocar [inicio, fin).
interface DatosRango {
  horarioGeneral: Map<number, Horario>;
  horarioPropio: Map<string, Map<number, Horario>>;
  ocupadoGeneral: Intervalo[];
  ocupadoPropio: Map<string, Intervalo[]>;
}

function agregar<T>(mapa: Map<string, T[]>, clave: string, valor: T): void {
  const lista = mapa.get(clave);
  if (lista) lista.push(valor);
  else mapa.set(clave, [valor]);
}

async function cargarRango(
  barberiaId: string,
  candidatos: string[],
  inicio: Date,
  fin: Date,
  instante: Date,
): Promise<DatosRango> {
  // Horario general y bloqueos de toda la barberia (perfilBarberoId nulo) mas los de los candidatos.
  const alcance = [{ perfilBarberoId: null }, { perfilBarberoId: { in: candidatos } }];
  const [horarios, bloqueos, citas] = await Promise.all([
    baseDatos.horarioAtencion.findMany({
      where: { barberiaId, OR: alcance },
      select: {
        perfilBarberoId: true,
        diaSemana: true,
        horaApertura: true,
        horaCierre: true,
        inicioPausa: true,
        finPausa: true,
      },
    }),
    baseDatos.bloqueo.findMany({
      where: { barberiaId, OR: alcance, iniciaEn: { lt: fin }, terminaEn: { gt: inicio } },
      select: { perfilBarberoId: true, iniciaEn: true, terminaEn: true },
    }),
    // PENDIENTE y CONFIRMADA ocupan; una PENDIENTE con anticipoVenceEn pasado no (RN-34, §4.7),
    // sin cancelarla aqui: este GET solo lee (el proceso programado y POST /citas la cancelan).
    baseDatos.cita.findMany({
      where: {
        barberiaId,
        perfilBarberoId: { in: candidatos },
        iniciaEn: { gte: new Date(inicio.getTime() - MS_DIA), lt: fin },
        terminaEn: { gt: inicio },
        OR: [
          { estado: 'CONFIRMADA' },
          {
            estado: 'PENDIENTE',
            OR: [{ anticipoVenceEn: null }, { anticipoVenceEn: { gte: instante } }],
          },
        ],
      },
      select: { perfilBarberoId: true, iniciaEn: true, terminaEn: true },
    }),
  ]);

  const datos: DatosRango = {
    horarioGeneral: new Map(),
    horarioPropio: new Map(),
    ocupadoGeneral: [],
    ocupadoPropio: new Map(),
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
    if (bloqueo.perfilBarberoId === null) datos.ocupadoGeneral.push(intervalo);
    else agregar(datos.ocupadoPropio, bloqueo.perfilBarberoId, intervalo);
  }
  for (const cita of citas) {
    agregar(datos.ocupadoPropio, cita.perfilBarberoId, {
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

// Inicios libres de un barbero en un dia (pasos 1 a 5 de la skill). Con soloUno para en el primero.
function iniciosDeBarbero(
  perfilId: string,
  local: DiaLocal,
  datos: DatosRango,
  duracionMs: number,
  minimoInicio: number,
  soloUno: boolean,
): number[] {
  // RN-05, D-31 (N1): sin horario general o sin horario propio ese dia, no trabaja.
  const general = datos.horarioGeneral.get(local.diaSemana);
  const propio = datos.horarioPropio.get(perfilId)?.get(local.diaSemana);
  if (!general || !propio) return [];

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
  if (!(trabajo.inicio < trabajo.fin)) return [];

  // RN-05: pausas de ambos horarios; RN-26: bloqueos suyos y de toda la barberia; RN-04: citas.
  const ocupados: Intervalo[] = [
    ...datos.ocupadoGeneral,
    ...(datos.ocupadoPropio.get(perfilId) ?? []),
  ];
  for (const horario of [general, propio]) {
    if (horario.inicioPausa !== null && horario.finPausa !== null) {
      ocupados.push({
        inicio: instanteLocal(local.dia, horario.inicioPausa),
        fin: instanteLocal(local.dia, horario.finPausa),
      });
    }
  }
  const libres = restar(trabajo, ocupados);

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
  const hoy = DateTime.fromJSDate(instante, { zone: zona }).startOf('day');
  const hoyFecha = hoy.toISODate() ?? '';
  const ultimaFecha = hoy.plus({ days: barberia.diasMaxAnticipacion }).toISODate() ?? '';
  const minimoInicio = instante.getTime() + barberia.minutosMinAnticipacion * MS_MINUTO;

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
  const preparacion = await preparar(id, consulta);
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
  const preparacion = await preparar(id, consulta);
  const dias = await calcular(preparacion, consulta.desde, consulta.hasta, true);
  return dias.map((dia) => ({ fecha: dia.fecha, disponible: dia.inicios.length > 0 }));
}
