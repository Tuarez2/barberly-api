// Disponibilidad, GET /barberias/:id/disponibilidad y /barberias/:id/disponibilidad/dias
// (T3.2, RES-03, RES-04, RN-04 a RN-07, RN-10, RN-23, RN-26, RN-34, D-31, D-33, SEG-02, RNF-01).
// Especificacion: docs/especificaciones/reservas.md (Contratos, Criterios, Dudas D1, D5, D7, N1)
// y la skill disponibilidad-horarios (algoritmo, zona horaria, Cualquiera disponible, rendimiento).
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../app';
import { baseDatos } from '../../compartido/base-datos';
import { fijarAhora, restaurarAhora } from '../../compartido/reloj';
import type { EstadoCita } from '../../generado/prisma/client';
import {
  crearBarberoDePrueba,
  crearBloqueoDePrueba,
  crearCitaDePrueba,
  crearHorarioDePrueba,
  crearUsuarioDePrueba,
  escenarioBase,
  IDS_PRUEBA,
  idPrueba,
  limpiarBase,
} from '../../pruebas/fabricas';
import { cabeceraDePrueba, tokenDePrueba } from '../../pruebas/sesiones';

const RUTA = '/api/v1/barberias';
const CENTRO = IDS_PRUEBA.barberia;
const NORTE = IDS_PRUEBA.otraBarberia;
const CARLOS = IDS_PRUEBA.perfilBarbero; // Centro: Corte clasico y Barba
const ANDRES = IDS_PRUEBA.perfilBarberoOtra; // Norte: su propio Corte clasico
const CORTE = IDS_PRUEBA.servicioCorte; // 30 min
const BARBA = IDS_PRUEBA.servicioBarba; // 30 min
const CORTE_NORTE = IDS_PRUEBA.servicioOtra;

// Segundo barbero de Centro para Cualquiera disponible.
const USUARIO_LUIS = idPrueba(106);
const LUIS = idPrueba(303);

// diaSemana 0 = domingo (D5). 2026-12-01 es martes; America/Guayaquil es UTC-5 todo el ano.
const HOY = '2026-12-01';
const MIERCOLES = '2026-12-02';
const MIERCOLES_DIA = 3;
const GUAYAQUIL = '-05:00';
const MADRID = '+01:00'; // Europe/Madrid en diciembre (sin horario de verano)

function local(fecha: string, hora: string, desfase: string = GUAYAQUIL): Date {
  return new Date(`${fecha}T${hora}:00${desfase}`);
}
function iso(fecha: string, hora: string, desfase: string = GUAYAQUIL): string {
  return local(fecha, hora, desfase).toISOString();
}
// Inicios cada 15 minutos de `desde` a `hasta`, ambos incluidos, en ISO UTC.
function bloques(fecha: string, desde: string, hasta: string, desfase = GUAYAQUIL): string[] {
  const inicio = local(fecha, desde, desfase).getTime();
  const fin = local(fecha, hasta, desfase).getTime();
  const resultado: string[] = [];
  for (let t = inicio; t <= fin; t += 15 * 60_000) resultado.push(new Date(t).toISOString());
  return resultado;
}
const sin = (lista: string[], quitar: string[]) => lista.filter((h) => !quitar.includes(h));

// Carlos trabaja 09:00-19:00 con pausa 13:00-14:00 (igual que el horario general de Centro):
// con un servicio de 30 min, de 09:00 a 12:30 y de 14:00 a 18:30.
const DIA_COMPLETO = [
  ...bloques(MIERCOLES, '09:00', '12:30'),
  ...bloques(MIERCOLES, '14:00', '18:30'),
];

const CONSULTA_HORARIOS = { servicioId: CORTE, barberoId: CARLOS, fecha: MIERCOLES };
const CONSULTA_DIAS = { servicioId: CORTE, barberoId: CARLOS, desde: HOY, hasta: '2026-12-07' };

type Consulta = Record<string, string | number>;

function pedir(
  sufijo: string,
  consulta: Consulta,
  usuarioId: string = IDS_PRUEBA.cliente,
  barberiaId: string = CENTRO,
) {
  return request(app)
    .get(`${RUTA}/${barberiaId}/disponibilidad${sufijo}`)
    .query(consulta)
    .set(cabeceraDePrueba(tokenDePrueba(usuarioId)));
}
const consultarHorarios = (
  consulta: Consulta = CONSULTA_HORARIOS,
  usuarioId?: string,
  barberiaId?: string,
) => pedir('', consulta, usuarioId, barberiaId);
const consultarDias = (
  consulta: Consulta = CONSULTA_DIAS,
  usuarioId?: string,
  barberiaId?: string,
) => pedir('/dias', consulta, usuarioId, barberiaId);

// Exigen 200 primero: mientras la ruta no exista, el fallo muestra el 404 y no un TypeError.
async function horarios(consulta: Consulta = {}, barberiaId: string = CENTRO): Promise<string[]> {
  const respuesta = await consultarHorarios(
    { ...CONSULTA_HORARIOS, ...consulta },
    undefined,
    barberiaId,
  );
  expect(respuesta.status).toBe(200);
  return respuesta.body.datos.horarios.map((h: { iniciaEn: string }) => h.iniciaEn);
}
// Copia de la consulta sin barberoId (Cualquiera disponible).
function sinBarberoId(consulta: Consulta): Consulta {
  return Object.fromEntries(Object.entries(consulta).filter(([clave]) => clave !== 'barberoId'));
}
async function sinBarbero(consulta: Consulta = {}): Promise<string[]> {
  const respuesta = await consultarHorarios({ ...sinBarberoId(CONSULTA_HORARIOS), ...consulta });
  expect(respuesta.status).toBe(200);
  return respuesta.body.datos.horarios.map((h: { iniciaEn: string }) => h.iniciaEn);
}
async function dias(consulta: Consulta = CONSULTA_DIAS, barberiaId: string = CENTRO) {
  const respuesta = await consultarDias(consulta, undefined, barberiaId);
  expect(respuesta.status).toBe(200);
  return respuesta.body.datos as { fecha: string; disponible: boolean }[];
}
async function mapaDias(consulta: Consulta = CONSULTA_DIAS, barberiaId?: string) {
  return Object.fromEntries((await dias(consulta, barberiaId)).map((d) => [d.fecha, d.disponible]));
}

function esperarError(respuesta: request.Response, estado: number, codigo: string) {
  expect(respuesta.status).toBe(estado);
  expect(respuesta.body.error.codigo).toBe(codigo);
  expect(respuesta.body.error.mensaje).toEqual(expect.any(String));
  expect(respuesta.body.datos).toBeUndefined();
}
const esperarNoEncontrado = (respuesta: request.Response) =>
  esperarError(respuesta, 404, 'NO_ENCONTRADO');
function esperarInvalido(respuesta: request.Response) {
  esperarError(respuesta, 422, 'DATOS_INVALIDOS');
  expect(respuesta.body.error.detalles).toEqual(expect.any(Array));
}

async function citaDeCarlos(
  hora: string,
  opciones: { estado?: EstadoCita; anticipoVenceEn?: Date; fecha?: string } = {},
) {
  return crearCitaDePrueba({
    barberiaId: CENTRO,
    perfilBarberoId: CARLOS,
    servicioId: CORTE,
    iniciaEn: local(opciones.fecha ?? MIERCOLES, hora),
    estado: opciones.estado,
    anticipoVenceEn: opciones.anticipoVenceEn,
  });
}

async function horarioPropioDeCarlos(
  diaSemana: number,
  datos: {
    horaApertura: string;
    horaCierre: string;
    inicioPausa?: string | null;
    finPausa?: string | null;
  },
) {
  await baseDatos.horarioAtencion.updateMany({
    where: { perfilBarberoId: CARLOS, diaSemana },
    data: { inicioPausa: null, finPausa: null, ...datos },
  });
}
async function horarioGeneralDeCentro(
  diaSemana: number,
  datos: {
    horaApertura: string;
    horaCierre: string;
    inicioPausa?: string | null;
    finPausa?: string | null;
  },
) {
  await baseDatos.horarioAtencion.updateMany({
    where: { barberiaId: CENTRO, perfilBarberoId: null, diaSemana },
    data: { inicioPausa: null, finPausa: null, ...datos },
  });
}

// Luis: barbero ACTIVO de Centro que solo ofrece Corte clasico. Sin horario propio salvo que se pida.
async function crearLuis(horario?: {
  dias?: number[];
  horaApertura: string;
  horaCierre: string;
  inicioPausa?: string;
  finPausa?: string;
}) {
  await crearUsuarioDePrueba({ id: USUARIO_LUIS, nombre: 'Luis', correo: 'luis@barberly.test' });
  await crearBarberoDePrueba({
    usuarioId: USUARIO_LUIS,
    barberiaId: CENTRO,
    perfilId: LUIS,
    nombreVisible: 'Luis',
    servicioIds: [CORTE],
  });
  if (horario)
    await crearHorarioDePrueba({ barberiaId: CENTRO, perfilBarberoId: LUIS, ...horario });
}

async function actualizarBarberia(id: string, data: Record<string, unknown>) {
  await baseDatos.barberia.update({ where: { id }, data });
}

beforeEach(async () => {
  await limpiarBase();
  // Centro (propietario; Carlos con Corte y Barba) y Norte (propietaria otra; Andres), publicadas,
  // horario general 09:00-19:00 con pausa 13:00-14:00 los 7 dias; mas un cliente.
  await escenarioBase();
  // D-31: sin horario propio el barbero no trabaja; Carlos recibe el mismo horario que la barberia.
  await crearHorarioDePrueba({
    barberiaId: CENTRO,
    perfilBarberoId: CARLOS,
    inicioPausa: '13:00',
    finPausa: '14:00',
  });
  fijarAhora(local(HOY, '10:00'));
});

afterEach(() => {
  restaurarAhora();
});

afterAll(async () => {
  await limpiarBase();
  await baseDatos.$disconnect();
});

describe('RES-04: GET /api/v1/barberias/:id/disponibilidad', () => {
  it('RES-04: responde 200 { datos: { fecha, horarios: [{ iniciaEn }] } } en ISO UTC, ascendentes, en bloques de 15 min', async () => {
    const respuesta = await consultarHorarios();

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({
      datos: { fecha: MIERCOLES, horarios: DIA_COMPLETO.map((iniciaEn) => ({ iniciaEn })) },
    });
    // 09:00 locales son 14:00 UTC.
    expect(respuesta.body.datos.horarios[0].iniciaEn).toBe('2026-12-02T14:00:00.000Z');
  });

  it('RN-10: el ultimo inicio termina justo al cierre (18:30) y el que lo pasa (18:45) no se ofrece; tampoco 12:45 antes de la pausa', async () => {
    const lista = await horarios();

    expect(lista).toContain(iso(MIERCOLES, '18:30'));
    expect(lista).not.toContain(iso(MIERCOLES, '18:45'));
    expect(lista).toContain(iso(MIERCOLES, '12:30'));
    expect(lista).not.toContain(iso(MIERCOLES, '12:45'));
    expect(lista).toContain(iso(MIERCOLES, '14:00'));
  });

  it('RN-10: un servicio de 45 min solo se ofrece donde cabe completo, incluido el hueco exacto', async () => {
    await baseDatos.servicio.create({
      data: {
        id: idPrueba(404),
        barberiaId: CENTRO,
        nombre: 'Corte premium',
        precio: '12.00',
        duracionMinutos: 45,
      },
    });
    await baseDatos.servicioBarbero.create({
      data: { perfilBarberoId: CARLOS, servicioId: idPrueba(404), barberiaId: CENTRO },
    });
    // Libre: 09:00-10:00, 10:30-11:00 (30 min, 15 menos que el servicio), 11:30-13:00 y 14:00-19:00.
    await citaDeCarlos('10:00');
    await citaDeCarlos('11:00');

    expect(await horarios({ servicioId: idPrueba(404) })).toEqual([
      ...bloques(MIERCOLES, '09:00', '09:15'),
      ...bloques(MIERCOLES, '11:30', '12:15'),
      ...bloques(MIERCOLES, '14:00', '18:15'),
    ]);
    // Con 30 min el hueco 10:30-11:00 es exacto: se ofrece.
    expect(await horarios()).toEqual([
      ...bloques(MIERCOLES, '09:00', '09:30'),
      iso(MIERCOLES, '10:30'),
      ...bloques(MIERCOLES, '11:30', '12:30'),
      ...bloques(MIERCOLES, '14:00', '18:30'),
    ]);
  });

  it('una fecha distinta responde con esa fecha', async () => {
    const respuesta = await consultarHorarios({ ...CONSULTA_HORARIOS, fecha: '2026-12-10' });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.datos.fecha).toBe('2026-12-10');
    expect(respuesta.body.datos.horarios[0]).toEqual({ iniciaEn: iso('2026-12-10', '09:00') });
  });
});

describe('RN-05, D-31: horario de la barberia ∩ horario propio del barbero', () => {
  it('RN-05: el horario propio se recorta al de la barberia (propio 08:00-11:00 → 09:00 a 10:30)', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '08:00', horaCierre: '11:00' });

    expect(await horarios()).toEqual(bloques(MIERCOLES, '09:00', '10:30'));
  });

  it('RN-05: el horario de la barberia se recorta al propio (propio 15:00-21:00 → 15:00 a 18:30)', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '15:00', horaCierre: '21:00' });

    expect(await horarios()).toEqual(bloques(MIERCOLES, '15:00', '18:30'));
  });

  it('D-31 (N1): sin horario propio ese dia el barbero no trabaja aunque la barberia abra', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { perfilBarberoId: CARLOS, diaSemana: MIERCOLES_DIA },
    });

    expect(await horarios()).toEqual([]);
    // Los demas dias sigue trabajando.
    expect(await horarios({ fecha: '2026-12-03' })).toEqual(
      DIA_COMPLETO.map((h) => h.replace('2026-12-02', '2026-12-03')),
    );
  });

  it('RN-05: sin horario general ese dia no hay horarios aunque el barbero tenga el suyo', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { barberiaId: CENTRO, perfilBarberoId: null, diaSemana: MIERCOLES_DIA },
    });

    expect(await horarios()).toEqual([]);
  });

  it('D5: diaSemana 0 es domingo: solo el domingo 2026-12-06 pierde horarios al quitar el dia 0', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { perfilBarberoId: CARLOS, diaSemana: 0 },
    });

    expect(await horarios({ fecha: '2026-12-06' })).toEqual([]);
    expect(await horarios({ fecha: '2026-12-07' })).not.toEqual([]);
    expect(await horarios({ fecha: '2026-12-05' })).not.toEqual([]);
  });

  it('RN-05: la pausa propia del barbero se resta (11:00-12:00 quita 10:45 a 11:45)', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, {
      horaApertura: '09:00',
      horaCierre: '19:00',
      inicioPausa: '11:00',
      finPausa: '12:00',
    });

    expect(await horarios()).toEqual([
      ...bloques(MIERCOLES, '09:00', '10:30'),
      ...bloques(MIERCOLES, '12:00', '12:30'),
      ...bloques(MIERCOLES, '14:00', '18:30'),
    ]);
  });

  it('RN-05: la pausa de la barberia tambien recorta a un barbero sin pausa propia', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '19:00' });

    expect(await horarios()).toEqual(DIA_COMPLETO);
  });
});

describe('RN-04, RN-11: citas activas ocupan', () => {
  it('RN-04 (PO-03): una cita 09:30-10:00 deja libres 09:00 y 10:00; ocupa 09:15, 09:30 y 09:45', async () => {
    await citaDeCarlos('09:30');

    expect(await horarios()).toEqual(
      sin(DIA_COMPLETO, [
        iso(MIERCOLES, '09:15'),
        iso(MIERCOLES, '09:30'),
        iso(MIERCOLES, '09:45'),
      ]),
    );
  });

  it.each(['CANCELADA', 'COMPLETADA', 'AUSENTE'] as const)(
    'una cita %s no ocupa el horario',
    async (estado) => {
      await citaDeCarlos('10:00', { estado });

      expect(await horarios()).toEqual(DIA_COMPLETO);
    },
  );

  it('una PENDIENTE vigente ocupa el horario', async () => {
    await citaDeCarlos('10:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: new Date(local(HOY, '10:00').getTime() + 15 * 60_000),
    });

    expect(await horarios()).not.toContain(iso(MIERCOLES, '10:00'));
  });

  it('RN-34: una PENDIENTE con anticipoVenceEn pasado no ocupa, sin esperar al proceso programado', async () => {
    await citaDeCarlos('10:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: new Date(local(HOY, '10:00').getTime() - 60_000),
    });

    expect(await horarios()).toEqual(DIA_COMPLETO);
  });

  it('las citas de otro barbero y las de otra barberia no ocupan a Carlos', async () => {
    await crearLuis({ horaApertura: '09:00', horaCierre: '19:00' });
    await crearCitaDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: LUIS,
      servicioId: CORTE,
      iniciaEn: local(MIERCOLES, '10:00'),
    });
    await crearCitaDePrueba({
      barberiaId: NORTE,
      perfilBarberoId: ANDRES,
      servicioId: CORTE_NORTE,
      iniciaEn: local(MIERCOLES, '11:00'),
    });

    expect(await horarios()).toEqual(DIA_COMPLETO);
  });
});

describe('RN-06: anticipacion minima', () => {
  it('RN-06: hoy a las 10:00 con 30 min, el inicio exacto 10:30 se ofrece y 10:15 no', async () => {
    expect(await horarios({ fecha: HOY })).toEqual([
      ...bloques(HOY, '10:30', '12:30'),
      ...bloques(HOY, '14:00', '18:30'),
    ]);
  });

  it('RN-06: a las 10:01 el primer inicio es 10:45', async () => {
    fijarAhora(new Date(local(HOY, '10:00').getTime() + 60_000));

    expect((await horarios({ fecha: HOY }))[0]).toBe(iso(HOY, '10:45'));
  });

  it('RN-06: con minutosMinAnticipacion 60 el primer inicio es 11:00', async () => {
    await actualizarBarberia(CENTRO, { minutosMinAnticipacion: 60 });

    expect((await horarios({ fecha: HOY }))[0]).toBe(iso(HOY, '11:00'));
  });

  it('RN-06: a las 18:00 solo queda 18:30; a las 18:01 ya no queda ninguno', async () => {
    fijarAhora(local(HOY, '18:00'));
    expect(await horarios({ fecha: HOY })).toEqual([iso(HOY, '18:30')]);

    fijarAhora(new Date(local(HOY, '18:00').getTime() + 60_000));
    expect(await horarios({ fecha: HOY })).toEqual([]);
  });
});

describe('RN-07, D5: fechas pasadas y anticipacion maxima por fecha local', () => {
  it('una fecha pasada responde 200 con lista vacia', async () => {
    expect(await horarios({ fecha: '2026-11-30' })).toEqual([]);
  });

  it('RN-07: con diasMaxAnticipacion 30, el 2026-12-31 (hoy + 30) tiene el dia completo y el 2027-01-01 no tiene horarios', async () => {
    const ultimo = await horarios({ fecha: '2026-12-31' });

    expect(ultimo[0]).toBe(iso('2026-12-31', '09:00'));
    expect(ultimo.at(-1)).toBe(iso('2026-12-31', '18:30'));
    expect(await horarios({ fecha: '2027-01-01' })).toEqual([]);
  });

  it('RN-07: con diasMaxAnticipacion 7, el 2026-12-08 se ofrece y el 2026-12-09 no', async () => {
    await actualizarBarberia(CENTRO, { diasMaxAnticipacion: 7 });

    expect(await horarios({ fecha: '2026-12-08' })).not.toEqual([]);
    expect(await horarios({ fecha: '2026-12-09' })).toEqual([]);
  });

  it('D5: a las 20:00 locales (01:00 UTC del dia siguiente) hoy sigue siendo 2026-12-01: el 2027-01-01 queda fuera', async () => {
    fijarAhora(local(HOY, '20:00'));

    expect(await horarios({ fecha: '2026-12-31' })).not.toEqual([]);
    expect(await horarios({ fecha: '2027-01-01' })).toEqual([]);
  });
});

describe('RN-26: bloqueos, dias libres y cierres de la barberia', () => {
  it('RN-26: un Bloqueo del barbero 10:00-12:00 quita 09:45 a 11:45', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '10:00'),
      terminaEn: local(MIERCOLES, '12:00'),
    });

    expect(await horarios()).toEqual([
      ...bloques(MIERCOLES, '09:00', '09:30'),
      ...bloques(MIERCOLES, '12:00', '12:30'),
      ...bloques(MIERCOLES, '14:00', '18:30'),
    ]);
  });

  it('RN-04: un Bloqueo que termina a las 10:00 deja libre el inicio de las 10:00', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '09:00'),
      terminaEn: local(MIERCOLES, '10:00'),
    });

    expect((await horarios())[0]).toBe(iso(MIERCOLES, '10:00'));
  });

  it('RN-26: un cierre de toda la barberia 15:00-16:00 quita 14:45 a 15:45', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local(MIERCOLES, '15:00'),
      terminaEn: local(MIERCOLES, '16:00'),
    });

    expect(await horarios()).toEqual(sin(DIA_COMPLETO, bloques(MIERCOLES, '14:45', '15:45')));
  });

  it('RN-26: un cierre de toda la barberia el dia entero deja el dia sin horarios', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local(MIERCOLES, '00:00'),
      terminaEn: local('2026-12-03', '00:00'),
    });

    expect(await horarios()).toEqual([]);
  });

  it('RN-26: un dia libre de varios dias (vacaciones del barbero) deja sin horarios cada dia que cubre', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '00:00'),
      terminaEn: local('2026-12-04', '00:00'),
      motivo: 'Vacaciones',
    });

    expect(await horarios()).toEqual([]);
    expect(await horarios({ fecha: '2026-12-03' })).toEqual([]);
    expect(await horarios({ fecha: '2026-12-04' })).not.toEqual([]);
  });

  it('los bloqueos de otro barbero y de otra barberia no afectan a Carlos', async () => {
    await crearLuis();
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: LUIS,
      iniciaEn: local(MIERCOLES, '09:00'),
      terminaEn: local(MIERCOLES, '19:00'),
    });
    await crearBloqueoDePrueba({
      barberiaId: NORTE,
      iniciaEn: local(MIERCOLES, '09:00'),
      terminaEn: local(MIERCOLES, '19:00'),
    });

    expect(await horarios()).toEqual(DIA_COMPLETO);
  });
});

describe('Zona horaria', () => {
  it('una cita a las 20:00 locales (01:00 UTC del dia siguiente) ocupa su fecha local', async () => {
    await horarioGeneralDeCentro(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '21:00' });
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '21:00' });
    const cita = await citaDeCarlos('20:00');
    expect(cita.iniciaEn.toISOString()).toBe('2026-12-03T01:00:00.000Z');

    expect(await horarios()).toEqual([
      ...bloques(MIERCOLES, '09:00', '19:30'),
      iso(MIERCOLES, '20:30'),
    ]);
  });

  describe('con Norte en Europe/Madrid (UTC+1 en diciembre)', () => {
    beforeEach(async () => {
      await actualizarBarberia(NORTE, { zonaHoraria: 'Europe/Madrid' });
      await crearHorarioDePrueba({
        barberiaId: NORTE,
        perfilBarberoId: ANDRES,
        inicioPausa: '13:00',
        finPausa: '14:00',
      });
    });

    it('las horas locales de Madrid se convierten a UTC y la anticipacion se mide en su reloj', async () => {
      // 07:45 UTC = 08:45 en Madrid (02:45 en Guayaquil): el primer inicio es 09:15 de Madrid.
      fijarAhora(new Date('2026-12-02T07:45:00Z'));

      expect(
        await horarios({ servicioId: CORTE_NORTE, barberoId: ANDRES, fecha: MIERCOLES }, NORTE),
      ).toEqual([
        ...bloques(MIERCOLES, '09:15', '12:30', MADRID),
        ...bloques(MIERCOLES, '14:00', '18:30', MADRID),
      ]);
    });

    it('D5: hoy y el limite de 30 dias salen de la fecha local de cada barberia', async () => {
      // 03:00 UTC del 2 de diciembre: en Madrid ya es 2 (04:00) y en Guayaquil sigue siendo 1 (22:00).
      fijarAhora(new Date('2026-12-02T03:00:00Z'));
      const norte = { servicioId: CORTE_NORTE, barberoId: ANDRES };

      expect(await horarios({ ...norte, fecha: HOY }, NORTE)).toEqual([]);
      expect(await horarios({ ...norte, fecha: '2027-01-01' }, NORTE)).not.toEqual([]);
      expect(await horarios({ fecha: '2027-01-01' })).toEqual([]);
      expect(await horarios({ fecha: '2026-12-31' })).not.toEqual([]);
    });
  });
});

describe('RES-02: Cualquiera disponible (sin barberoId)', () => {
  it('une los horarios de los candidatos sin repetir inicios: libre con uno se ofrece, ocupado en todos no', async () => {
    await crearLuis({
      horaApertura: '09:00',
      horaCierre: '19:00',
      inicioPausa: '13:00',
      finPausa: '14:00',
    });
    await citaDeCarlos('10:00');
    await citaDeCarlos('11:00');
    await crearCitaDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: LUIS,
      servicioId: CORTE,
      iniciaEn: local(MIERCOLES, '11:00'),
    });

    const respuesta = await consultarHorarios({ servicioId: CORTE, fecha: MIERCOLES });

    expect(respuesta.status).toBe(200);
    // Sin barbero asignado: cada elemento solo trae iniciaEn.
    expect(respuesta.body.datos).toEqual({
      fecha: MIERCOLES,
      horarios: sin(DIA_COMPLETO, bloques(MIERCOLES, '10:45', '11:15')).map((iniciaEn) => ({
        iniciaEn,
      })),
    });
  });

  it('suma tramos distintos: Carlos 09:00-12:00 y Luis 15:00-17:00, ordenados en UTC', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '12:00' });
    await crearLuis({ dias: [MIERCOLES_DIA], horaApertura: '15:00', horaCierre: '17:00' });

    expect(await sinBarbero()).toEqual([
      ...bloques(MIERCOLES, '09:00', '11:30'),
      ...bloques(MIERCOLES, '15:00', '16:30'),
    ]);
  });

  it('RN-23: solo cuentan los barberos que ofrecen el servicio (Luis no ofrece Barba)', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '12:00' });
    await crearLuis({ dias: [MIERCOLES_DIA], horaApertura: '15:00', horaCierre: '17:00' });

    expect(await sinBarbero({ servicioId: BARBA })).toEqual(bloques(MIERCOLES, '09:00', '11:30'));
  });

  it('D-33: un barbero con Usuario inactivo no aporta horarios', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '12:00' });
    await crearLuis({ dias: [MIERCOLES_DIA], horaApertura: '15:00', horaCierre: '17:00' });
    await baseDatos.usuario.update({ where: { id: USUARIO_LUIS }, data: { activo: false } });

    expect(await sinBarbero()).toEqual(bloques(MIERCOLES, '09:00', '11:30'));
  });

  it.each(['INACTIVO', 'INVITADO'] as const)(
    'D-33: un barbero con membresia %s no aporta horarios',
    async (estado) => {
      await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '12:00' });
      await crearLuis({ dias: [MIERCOLES_DIA], horaApertura: '15:00', horaCierre: '17:00' });
      await baseDatos.membresia.update({
        where: { usuarioId_barberiaId: { usuarioId: USUARIO_LUIS, barberiaId: CENTRO } },
        data: { estado },
      });

      expect(await sinBarbero()).toEqual(bloques(MIERCOLES, '09:00', '11:30'));
    },
  );

  it('RN-26: un cierre de toda la barberia quita el horario a todos los barberos', async () => {
    await crearLuis({ horaApertura: '09:00', horaCierre: '19:00' });
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local(MIERCOLES, '09:00'),
      terminaEn: local(MIERCOLES, '19:00'),
    });

    expect(await sinBarbero()).toEqual([]);
  });

  it('sin ningun barbero que ofrezca el servicio responde 200 con lista vacia', async () => {
    await baseDatos.servicioBarbero.deleteMany({ where: { servicioId: BARBA } });

    expect(await sinBarbero({ servicioId: BARBA })).toEqual([]);
  });
});

describe('RES-03: GET /api/v1/barberias/:id/disponibilidad/dias', () => {
  it('RES-03: responde 200 { datos: [{ fecha, disponible }] } con un elemento por dia del rango, en orden', async () => {
    const respuesta = await consultarDias();

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({
      datos: ['01', '02', '03', '04', '05', '06', '07'].map((dia) => ({
        fecha: `2026-12-${dia}`,
        disponible: true,
      })),
    });
  });

  it('desde igual a hasta responde un solo dia', async () => {
    expect(await dias({ ...CONSULTA_DIAS, desde: MIERCOLES, hasta: MIERCOLES })).toEqual([
      { fecha: MIERCOLES, disponible: true },
    ]);
  });

  it('31 dias es el maximo permitido', async () => {
    const lista = await dias({ ...CONSULTA_DIAS, desde: HOY, hasta: '2026-12-31' });

    expect(lista).toHaveLength(31);
    expect(lista.every((d) => d.disponible)).toBe(true);
  });

  it('los dias pasados salen con disponible falso; hoy es verdadero si le queda un inicio', async () => {
    expect(await mapaDias({ ...CONSULTA_DIAS, desde: '2026-11-29', hasta: MIERCOLES })).toEqual({
      '2026-11-29': false,
      '2026-11-30': false,
      [HOY]: true,
      [MIERCOLES]: true,
    });
  });

  it('RN-06: hoy a las 18:01 ya no queda ningun inicio: hoy es falso y manana verdadero', async () => {
    fijarAhora(new Date(local(HOY, '18:00').getTime() + 60_000));

    expect(await mapaDias({ ...CONSULTA_DIAS, desde: HOY, hasta: MIERCOLES })).toEqual({
      [HOY]: false,
      [MIERCOLES]: true,
    });
  });

  it('RN-07: fuera de diasMaxAnticipacion los dias son falsos (2026-12-31 si, 2027-01-01 no)', async () => {
    expect(await mapaDias({ ...CONSULTA_DIAS, desde: '2026-12-30', hasta: '2027-01-02' })).toEqual({
      '2026-12-30': true,
      '2026-12-31': true,
      '2027-01-01': false,
      '2027-01-02': false,
    });
  });

  it('D-31: un dia sin horario propio del barbero o sin horario general es falso', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { perfilBarberoId: CARLOS, diaSemana: MIERCOLES_DIA },
    });
    await baseDatos.horarioAtencion.deleteMany({
      where: { barberiaId: CENTRO, perfilBarberoId: null, diaSemana: 0 },
    });

    expect(await mapaDias()).toEqual({
      '2026-12-01': true,
      '2026-12-02': false,
      '2026-12-03': true,
      '2026-12-04': true,
      '2026-12-05': true,
      '2026-12-06': false,
      '2026-12-07': true,
    });
  });

  it('RN-26: un cierre de toda la barberia el dia entero marca disponible falso; uno parcial no', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local('2026-12-03', '00:00'),
      terminaEn: local('2026-12-04', '00:00'),
    });
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local('2026-12-05', '09:00'),
      terminaEn: local('2026-12-05', '12:00'),
    });

    const mapa = await mapaDias();
    expect(mapa['2026-12-03']).toBe(false);
    expect(mapa['2026-12-05']).toBe(true);
  });

  it('RN-26: las vacaciones del barbero (Bloqueo de varios dias) marcan falsos los dias que cubren', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local('2026-12-04', '00:00'),
      terminaEn: local('2026-12-07', '00:00'),
      motivo: 'Vacaciones',
    });

    expect(await mapaDias()).toEqual({
      '2026-12-01': true,
      '2026-12-02': true,
      '2026-12-03': true,
      '2026-12-04': false,
      '2026-12-05': false,
      '2026-12-06': false,
      '2026-12-07': true,
    });
  });

  it('un dia lleno de citas es falso; al cancelar una vuelve a ser verdadero', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '09:00', horaCierre: '10:00' });
    const primera = await citaDeCarlos('09:00');
    await citaDeCarlos('09:30');
    const consulta = { ...CONSULTA_DIAS, desde: MIERCOLES, hasta: MIERCOLES };

    expect(await dias(consulta)).toEqual([{ fecha: MIERCOLES, disponible: false }]);

    await baseDatos.cita.update({ where: { id: primera.id }, data: { estado: 'CANCELADA' } });
    expect(await dias(consulta)).toEqual([{ fecha: MIERCOLES, disponible: true }]);
  });

  it('una cita a las 20:00 locales cuenta en su fecha local, no en la fecha UTC', async () => {
    // Miercoles solo 20:00-20:30 en ambos horarios; la cita (01:00 UTC del jueves) lo llena.
    await horarioGeneralDeCentro(MIERCOLES_DIA, { horaApertura: '20:00', horaCierre: '20:30' });
    await horarioPropioDeCarlos(MIERCOLES_DIA, { horaApertura: '20:00', horaCierre: '20:30' });
    await citaDeCarlos('20:00');

    const mapa = await mapaDias({ ...CONSULTA_DIAS, desde: MIERCOLES, hasta: '2026-12-03' });
    expect(mapa).toEqual({ [MIERCOLES]: false, '2026-12-03': true });
  });

  it('con Norte en Europe/Madrid, hoy sale de su fecha local', async () => {
    await actualizarBarberia(NORTE, { zonaHoraria: 'Europe/Madrid' });
    await crearHorarioDePrueba({ barberiaId: NORTE, perfilBarberoId: ANDRES });
    // 03:00 UTC del 2: en Madrid ya es 2 (04:00), en Guayaquil sigue siendo 1 (22:00).
    fijarAhora(new Date('2026-12-02T03:00:00Z'));
    const consulta = { servicioId: CORTE_NORTE, barberoId: ANDRES, desde: HOY, hasta: MIERCOLES };

    expect(await mapaDias(consulta, NORTE)).toEqual({ [HOY]: false, [MIERCOLES]: true });
  });

  it('RES-02: Cualquiera disponible: el dia es verdadero si al menos un candidato tiene un inicio', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { perfilBarberoId: CARLOS, diaSemana: MIERCOLES_DIA },
    });
    await crearLuis({ dias: [MIERCOLES_DIA], horaApertura: '15:00', horaCierre: '17:00' });
    const consulta = { servicioId: CORTE, desde: MIERCOLES, hasta: MIERCOLES };

    expect(await dias(consulta)).toEqual([{ fecha: MIERCOLES, disponible: true }]);

    // D-33: con su Usuario inactivo, Luis deja de contar.
    await baseDatos.usuario.update({ where: { id: USUARIO_LUIS }, data: { activo: false } });
    expect(await dias(consulta)).toEqual([{ fecha: MIERCOLES, disponible: false }]);
  });
});

describe('Validacion de la consulta', () => {
  it.each([
    ['falta fecha', { servicioId: CORTE }],
    ['falta servicioId', { fecha: MIERCOLES }],
    ['fecha sin ceros (2026-12-2)', { servicioId: CORTE, fecha: '2026-12-2' }],
    ['fecha DD-MM-AAAA', { servicioId: CORTE, fecha: '02-12-2026' }],
    ['fecha inexistente (2026-02-30)', { servicioId: CORTE, fecha: '2026-02-30' }],
    ['fecha con hora', { servicioId: CORTE, fecha: '2026-12-02T10:00:00Z' }],
    ['servicioId que no es UUID', { servicioId: 'corte', fecha: MIERCOLES }],
    ['barberoId que no es UUID', { servicioId: CORTE, barberoId: 'carlos', fecha: MIERCOLES }],
    ['barberoId vacio', { servicioId: CORTE, barberoId: '', fecha: MIERCOLES }],
    ['parametro desconocido', { ...CONSULTA_HORARIOS, desde: MIERCOLES }],
  ])('GET /disponibilidad: %s responde 422 DATOS_INVALIDOS', async (_caso, consulta) => {
    expect((await consultarHorarios()).status).toBe(200);

    esperarInvalido(await consultarHorarios(consulta));
  });

  it('GET /disponibilidad: una fecha mal formada indica el campo fecha en detalles', async () => {
    const respuesta = await consultarHorarios({ servicioId: CORTE, fecha: '2026-12-2' });

    esperarInvalido(respuesta);
    expect(respuesta.body.error.detalles).toEqual(
      expect.arrayContaining([expect.objectContaining({ campo: 'fecha' })]),
    );
  });

  it.each([
    ['falta desde', { servicioId: CORTE, hasta: '2026-12-07' }],
    ['falta hasta', { servicioId: CORTE, desde: HOY }],
    ['falta servicioId', { desde: HOY, hasta: '2026-12-07' }],
    ['desde mal formado', { ...CONSULTA_DIAS, desde: '2026-12-1' }],
    ['hasta mal formado', { ...CONSULTA_DIAS, hasta: '2026/12/07' }],
    [
      'hasta inexistente (2026-02-30)',
      { ...CONSULTA_DIAS, desde: '2026-02-01', hasta: '2026-02-30' },
    ],
    ['desde posterior a hasta', { ...CONSULTA_DIAS, desde: '2026-12-07', hasta: HOY }],
    ['mas de 31 dias (32)', { ...CONSULTA_DIAS, desde: HOY, hasta: '2027-01-01' }],
    ['servicioId que no es UUID', { ...CONSULTA_DIAS, servicioId: 'corte' }],
    ['barberoId que no es UUID', { ...CONSULTA_DIAS, barberoId: 'carlos' }],
    ['parametro desconocido (fecha)', { ...CONSULTA_DIAS, fecha: MIERCOLES }],
  ])('GET /disponibilidad/dias: %s responde 422 DATOS_INVALIDOS', async (_caso, consulta) => {
    expect((await consultarDias()).status).toBe(200);

    esperarInvalido(await consultarDias(consulta));
  });
});

// Los dos endpoints comparten sesion, visibilidad y errores de servicio y barbero.
// Cada caso de 404 compara contra un control en 200 para no pasar mientras la ruta no exista.
describe.each([
  ['disponibilidad', '', CONSULTA_HORARIOS],
  ['disponibilidad/dias', '/dias', CONSULTA_DIAS],
] as const)('Errores comunes de GET /barberias/:id/%s', (_nombre, sufijo, base) => {
  const consultar = (consulta: Consulta = base, usuarioId?: string, barberiaId?: string) =>
    pedir(sufijo, consulta, usuarioId, barberiaId);
  const esperarControl = async (usuarioId?: string, barberiaId?: string) => {
    expect((await consultar(base, usuarioId, barberiaId)).status).toBe(200);
  };

  describe('sesion (Pub)', () => {
    it('sin token responde 401 AUTENTICACION_REQUERIDA', async () => {
      const respuesta = await request(app)
        .get(`${RUTA}/${CENTRO}/disponibilidad${sufijo}`)
        .query(base);

      esperarError(respuesta, 401, 'AUTENTICACION_REQUERIDA');
    });

    it('sin token y con una barberia inexistente responde 401 antes que 404', async () => {
      const respuesta = await request(app)
        .get(`${RUTA}/${idPrueba(999)}/disponibilidad${sufijo}`)
        .query(base);

      esperarError(respuesta, 401, 'AUTENTICACION_REQUERIDA');
    });

    it('con el token de acceso vencido responde 401 TOKEN_VENCIDO', async () => {
      const respuesta = await request(app)
        .get(`${RUTA}/${CENTRO}/disponibilidad${sufijo}`)
        .query(base)
        .set(cabeceraDePrueba(tokenDePrueba(IDS_PRUEBA.cliente, -1)));

      esperarError(respuesta, 401, 'TOKEN_VENCIDO');
    });

    it.each([
      ['cliente', IDS_PRUEBA.cliente],
      ['barbero', IDS_PRUEBA.barbero],
      ['propietario', IDS_PRUEBA.propietario],
      ['propietaria de otra barberia', IDS_PRUEBA.propietarioOtra],
    ])('cualquier usuario autenticado (%s) recibe 200', async (_rol, usuarioId) => {
      await esperarControl(usuarioId);
    });
  });

  describe('D7: barberia inexistente, no publicada o inactiva', () => {
    it('una barberia inexistente responde NO_ENCONTRADO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar(base, undefined, idPrueba(999)));
    });

    it('un id que no es UUID responde NO_ENCONTRADO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar(base, undefined, 'no-es-uuid'));
    });

    it.each([
      ['cliente', IDS_PRUEBA.cliente],
      ['propietario', IDS_PRUEBA.propietario],
      ['barbero ACTIVO', IDS_PRUEBA.barbero],
    ])('no publicada: NO_ENCONTRADO tambien para el %s', async (_rol, usuarioId) => {
      await esperarControl(usuarioId);
      await actualizarBarberia(CENTRO, { publicada: false });

      esperarNoEncontrado(await consultar(base, usuarioId));
    });

    it.each([
      ['cliente', IDS_PRUEBA.cliente],
      ['propietario', IDS_PRUEBA.propietario],
      ['barbero ACTIVO', IDS_PRUEBA.barbero],
    ])('inactiva (aunque publicada): NO_ENCONTRADO tambien para el %s', async (_rol, usuarioId) => {
      await esperarControl(usuarioId);
      await actualizarBarberia(CENTRO, { activo: false });

      esperarNoEncontrado(await consultar(base, usuarioId));
    });
  });

  describe('SEG-02: servicio y barbero de otra barberia o inexistentes → NO_ENCONTRADO', () => {
    it('SEG-02: el servicio de Norte en Centro responde NO_ENCONTRADO y no SERVICIO_NO_OFRECIDO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar({ ...base, servicioId: CORTE_NORTE }));
    });

    it('SEG-02: el servicio de Norte en Centro sin barberoId responde NO_ENCONTRADO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar({ ...sinBarberoId(base), servicioId: CORTE_NORTE }));
    });

    it('SEG-02: un servicioId inexistente responde NO_ENCONTRADO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar({ ...base, servicioId: idPrueba(998) }));
    });

    it('SEG-02: el barbero de Norte (que no ofrece el Corte de Centro) responde NO_ENCONTRADO y no SERVICIO_NO_OFRECIDO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar({ ...base, barberoId: ANDRES }));
    });

    it('SEG-02: un barberoId inexistente responde NO_ENCONTRADO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar({ ...base, barberoId: idPrueba(997) }));
    });

    it('SEG-02: el id del Usuario del barbero (no el de su PerfilBarbero) responde NO_ENCONTRADO', async () => {
      await esperarControl();

      esperarNoEncontrado(await consultar({ ...base, barberoId: IDS_PRUEBA.barbero }));
    });

    it('Aislamiento: el servicio y el barbero de Centro en Norte responden NO_ENCONTRADO', async () => {
      await crearHorarioDePrueba({ barberiaId: NORTE, perfilBarberoId: ANDRES });
      const norte = { ...base, servicioId: CORTE_NORTE, barberoId: ANDRES };
      expect((await consultar(norte, undefined, NORTE)).status).toBe(200);

      esperarNoEncontrado(await consultar({ ...norte, servicioId: CORTE }, undefined, NORTE));
      esperarNoEncontrado(await consultar({ ...norte, barberoId: CARLOS }, undefined, NORTE));
    });
  });

  describe('D-33: barbero con la cuenta desactivada', () => {
    it('D-33: con su barberoId responde NO_ENCONTRADO aunque su membresia siga ACTIVO', async () => {
      await esperarControl();
      await baseDatos.usuario.update({
        where: { id: IDS_PRUEBA.barbero },
        data: { activo: false },
      });

      esperarNoEncontrado(await consultar(base));
    });
  });

  describe('Barbero con membresia INVITADO (nunca fue publico)', () => {
    // Horarios: hay al menos un inicio; dias: hay al menos un dia disponible.
    const hayInicios = (respuesta: request.Response): boolean =>
      sufijo === ''
        ? respuesta.body.datos.horarios.length > 0
        : respuesta.body.datos.some((d: { disponible: boolean }) => d.disponible);

    it('con su barberoId responde NO_ENCONTRADO (ACTIVO da 200) y en Cualquiera disponible no cuenta', async () => {
      // Sin horario propio Carlos no trabaja (D-31): solo Luis puede aportar inicios.
      await baseDatos.horarioAtencion.deleteMany({ where: { perfilBarberoId: CARLOS } });
      await crearLuis({ horaApertura: '09:00', horaCierre: '19:00' });
      const conLuis = { ...base, barberoId: LUIS };
      const cualquiera = sinBarberoId(base);

      const activo = await consultar(conLuis);
      expect(activo.status).toBe(200);
      expect(hayInicios(activo)).toBe(true);
      const cualquieraActivo = await consultar(cualquiera);
      expect(cualquieraActivo.status).toBe(200);
      expect(hayInicios(cualquieraActivo)).toBe(true);

      await baseDatos.membresia.update({
        where: { usuarioId_barberiaId: { usuarioId: USUARIO_LUIS, barberiaId: CENTRO } },
        data: { estado: 'INVITADO' },
      });

      esperarNoEncontrado(await consultar(conLuis));
      const cualquieraInvitado = await consultar(cualquiera);
      expect(cualquieraInvitado.status).toBe(200);
      expect(hayInicios(cualquieraInvitado)).toBe(false);
    });
  });

  describe('RN-23: SERVICIO_NO_OFRECIDO y RECURSO_INACTIVO', () => {
    it('RN-23: un barbero de la barberia que no ofrece el servicio responde 422 SERVICIO_NO_OFRECIDO', async () => {
      await esperarControl();
      await baseDatos.servicioBarbero.delete({
        where: { perfilBarberoId_servicioId: { perfilBarberoId: CARLOS, servicioId: BARBA } },
      });

      esperarError(await consultar({ ...base, servicioId: BARBA }), 422, 'SERVICIO_NO_OFRECIDO');
    });

    it('un servicio inactivo responde 409 RECURSO_INACTIVO, con y sin barberoId', async () => {
      await esperarControl();
      await baseDatos.servicio.update({ where: { id: CORTE }, data: { activo: false } });

      esperarError(await consultar(base), 409, 'RECURSO_INACTIVO');
      esperarError(await consultar(sinBarberoId(base)), 409, 'RECURSO_INACTIVO');
    });

    it('un barbero con membresia INACTIVO responde 409 RECURSO_INACTIVO', async () => {
      await esperarControl();
      await baseDatos.membresia.update({
        where: { usuarioId_barberiaId: { usuarioId: IDS_PRUEBA.barbero, barberiaId: CENTRO } },
        data: { estado: 'INACTIVO' },
      });

      esperarError(await consultar(base), 409, 'RECURSO_INACTIVO');
    });
  });

  it('Solo lectura: no crea, cambia ni borra citas ni bloqueos', async () => {
    await citaDeCarlos('10:00');
    await citaDeCarlos('11:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: new Date(local(HOY, '10:00').getTime() + 15 * 60_000),
    });
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local(MIERCOLES, '15:00'),
      terminaEn: local(MIERCOLES, '16:00'),
    });
    const leer = async () => ({
      citas: await baseDatos.cita.findMany({ orderBy: { id: 'asc' } }),
      bloqueos: await baseDatos.bloqueo.findMany({ orderBy: { id: 'asc' } }),
    });
    const antes = await leer();

    await esperarControl();

    expect(await leer()).toEqual(antes);
  });
});

describe('RNF-01: rendimiento', () => {
  it('con 5 barberos y 1.000 citas, 31 dias y un dia con Cualquiera disponible responden en menos de 1 s', async () => {
    const perfiles = [CARLOS];
    for (let n = 0; n < 4; n += 1) {
      const usuarioId = idPrueba(150 + n);
      const perfilId = idPrueba(350 + n);
      await crearUsuarioDePrueba({ id: usuarioId, correo: `barbero${n}@barberly.test` });
      await crearBarberoDePrueba({
        usuarioId,
        barberiaId: CENTRO,
        perfilId,
        nombreVisible: `Barbero ${n}`,
        servicioIds: [CORTE],
      });
      await crearHorarioDePrueba({
        barberiaId: CENTRO,
        perfilBarberoId: perfilId,
        inicioPausa: '13:00',
        finPausa: '14:00',
      });
      perfiles.push(perfilId);
    }
    // 200 citas por barbero: 8 por dia (09:00 a 12:30) del 2026-12-02 al 2026-12-26.
    const citas = [];
    for (const perfilBarberoId of perfiles) {
      for (let dia = 0; dia < 25; dia += 1) {
        for (let k = 0; k < 8; k += 1) {
          const iniciaEn = new Date(
            local(MIERCOLES, '09:00').getTime() + dia * 86_400_000 + k * 30 * 60_000,
          );
          citas.push({
            id: idPrueba(100_000 + citas.length),
            barberiaId: CENTRO,
            clienteId: IDS_PRUEBA.cliente,
            perfilBarberoId,
            servicioId: CORTE,
            iniciaEn,
            terminaEn: new Date(iniciaEn.getTime() + 30 * 60_000),
            precioReserva: '8.00',
            duracionReserva: 30,
            estado: 'CONFIRMADA' as const,
          });
        }
      }
    }
    await baseDatos.cita.createMany({ data: citas });
    expect(citas).toHaveLength(1000);
    // Calentamiento: la primera solicitud no mide el arranque de la aplicacion.
    expect((await consultarHorarios()).status).toBe(200);

    let inicio = performance.now();
    const calendario = await consultarDias({ servicioId: CORTE, desde: HOY, hasta: '2026-12-31' });
    const msDias = performance.now() - inicio;

    inicio = performance.now();
    const dia = await consultarHorarios({ servicioId: CORTE, fecha: MIERCOLES });
    const msDia = performance.now() - inicio;

    expect(calendario.status).toBe(200);
    expect(calendario.body.datos).toHaveLength(31);
    expect(dia.status).toBe(200);
    // Las mananas estan llenas para todos (8 citas de 09:00 a 13:00): el primer inicio libre es 14:00.
    expect(dia.body.datos.horarios[0]).toEqual({ iniciaEn: iso(MIERCOLES, '14:00') });
    expect(msDias).toBeLessThan(1000);
    expect(msDia).toBeLessThan(1000);
  }, 30_000);
});

describe('§10.7: documentacion de la disponibilidad', () => {
  it.each(['/barberias/{id}/disponibilidad', '/barberias/{id}/disponibilidad/dias'])(
    'GET /api/v1/documentacion incluye GET %s con token de acceso y 200, 401, 404 y 422',
    async (ruta) => {
      const { body } = await request(app).get('/api/v1/documentacion');

      const operacion = body.paths[ruta]?.get;
      expect(operacion).toBeDefined();
      expect(Object.keys(operacion.responses)).toEqual(
        expect.arrayContaining(['200', '401', '404', '422']),
      );
      expect(operacion.security).toEqual([{ bearer: [] }]);
    },
  );
});
