// Crear cita, POST /api/v1/citas (T3.3, RES-06, RN-01 a RN-12, RN-34, HU-RES-01, HU-RES-04,
// PO-01 a PO-05, D-19, D-31, D-33, SEG-02).
// Especificacion: docs/especificaciones/reservas.md (Contratos, Criterios, Dudas D2, D4, D5, D6, D7,
// N1 a N4), DERCAS §8.5 (orden de validacion) y la skill reservas-concurrencia.
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../app';
import { baseDatos } from '../../compartido/base-datos';
import { configuracion } from '../../compartido/configuracion';
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

const RUTA = '/api/v1/citas';
const CENTRO = IDS_PRUEBA.barberia;
const NORTE = IDS_PRUEBA.otraBarberia;
const CARLOS = IDS_PRUEBA.perfilBarbero; // Centro: Corte clasico y Barba
const ANDRES = IDS_PRUEBA.perfilBarberoOtra; // Norte: su propio Corte clasico
const CORTE = IDS_PRUEBA.servicioCorte; // 30 min, 8.00
const BARBA = IDS_PRUEBA.servicioBarba; // 30 min, 5.00
const CORTE_NORTE = IDS_PRUEBA.servicioOtra;
const CLIENTE = IDS_PRUEBA.cliente;

// Otra clienta: duena de las citas que ocupan a Carlos y de las reservas de control.
const ANA = idPrueba(107);
// Barberos extra de Centro (solo Corte clasico). Bruno tiene el id menor que Carlos (empates, CU-07 A3).
const USUARIO_LUIS = idPrueba(106);
const LUIS = idPrueba(303);
const USUARIO_PEDRO = idPrueba(108);
const PEDRO = idPrueba(304);
const USUARIO_BRUNO = idPrueba(109);
const BRUNO = idPrueba(300);

// diaSemana 0 = domingo (D5). 2026-12-01 es martes; America/Guayaquil es UTC-5 todo el ano.
const HOY = '2026-12-01';
const MIERCOLES = '2026-12-02';
const MIERCOLES_DIA = 3;
const JUEVES = '2026-12-03';
const GUAYAQUIL = '-05:00';
const MINUTO = 60_000;

function local(fecha: string, hora: string, desfase: string = GUAYAQUIL): Date {
  return new Date(`${fecha}T${hora}:00${desfase}`);
}
function iso(fecha: string, hora: string): string {
  return local(fecha, hora).toISOString();
}
const enMinutos = (minutos: number, desde: Date = local(HOY, '10:00')) =>
  new Date(desde.getTime() + minutos * MINUTO);

// Claves de idempotencia deterministas: el contador se reinicia en cada prueba.
let numeroClave = 0;
const nuevaClave = () => idPrueba(800_000 + ++numeroClave);
const CLAVE_FIJA = idPrueba(899_999);

// Cada prueba sale de una IP distinta (X-Forwarded-For con un proxy confiable) para no llegar al
// limite global de 300 solicitudes por minuto de app.ts.
let numeroPrueba = 0;
let ip = '10.0.0.1';
const proxiesOriginales = configuracion.PROXIES_CONFIABLES;

type Cuerpo = Record<string, unknown>;

// Reserva valida por defecto: Carlos, Corte clasico, manana miercoles 10:00 locales.
function cuerpo(cambios: Cuerpo = {}): Cuerpo {
  return {
    barberiaId: CENTRO,
    servicioId: CORTE,
    barberoId: CARLOS,
    iniciaEn: iso(MIERCOLES, '10:00'),
    claveIdempotencia: nuevaClave(),
    ...cambios,
  };
}
// Sin barberoId = Cualquiera disponible (CU-07 A3).
function cualquiera(cambios: Cuerpo = {}): Cuerpo {
  const resto = cuerpo(cambios);
  delete resto.barberoId;
  return resto;
}
function sinCampo(campo: string, base: Cuerpo = cuerpo({ claveIdempotencia: CLAVE_FIJA })) {
  const copia = { ...base };
  delete copia[campo];
  return copia;
}

function reservar(datos: Cuerpo = cuerpo(), usuarioId: string = CLIENTE) {
  return request(app)
    .post(RUTA)
    .set('X-Forwarded-For', ip)
    .set(cabeceraDePrueba(tokenDePrueba(usuarioId)))
    .send(datos);
}
// Exige 201 primero: mientras la ruta no exista, el fallo muestra el 404 y no un TypeError.
async function crear(datos: Cuerpo = cuerpo(), usuarioId: string = CLIENTE) {
  const respuesta = await reservar(datos, usuarioId);
  expect(respuesta.status, JSON.stringify(respuesta.body)).toBe(201);
  return respuesta.body.datos;
}
// Control para los casos 404: una reserva valida de Ana a las 15:00 prueba que la ruta existe.
async function control() {
  await crear(cuerpo({ iniciaEn: iso(MIERCOLES, '15:00') }), ANA);
}

function esperarError(respuesta: request.Response, estado: number, codigo: string) {
  expect(respuesta.status, JSON.stringify(respuesta.body)).toBe(estado);
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

const citasActivasDe = (perfilBarberoId: string) =>
  baseDatos.cita.findMany({
    where: { perfilBarberoId, estado: { in: ['PENDIENTE', 'CONFIRMADA'] } },
    orderBy: { iniciaEn: 'asc' },
  });

async function citaDe(
  perfilBarberoId: string,
  fecha: string,
  hora: string,
  opciones: {
    clienteId?: string;
    estado?: EstadoCita;
    anticipoVenceEn?: Date;
    barberiaId?: string;
    servicioId?: string;
  } = {},
) {
  return crearCitaDePrueba({
    barberiaId: opciones.barberiaId ?? CENTRO,
    perfilBarberoId,
    servicioId: opciones.servicioId ?? CORTE,
    iniciaEn: local(fecha, hora),
    clienteId: opciones.clienteId ?? ANA,
    estado: opciones.estado,
    anticipoVenceEn: opciones.anticipoVenceEn,
  });
}
// Cita del cliente en Norte con Andres (para RN-08 y para comprobar que no cuenta en RN-09 de Centro).
const citaEnNorte = (
  fecha: string,
  hora: string,
  opciones: { estado?: EstadoCita; anticipoVenceEn?: Date } = {},
) =>
  citaDe(ANDRES, fecha, hora, {
    ...opciones,
    clienteId: CLIENTE,
    barberiaId: NORTE,
    servicioId: CORTE_NORTE,
  });

// Barbero ACTIVO de Centro que solo ofrece Corte clasico, con horario propio 09:00-19:00 los 7 dias.
async function crearBarbero(
  usuarioId: string,
  perfilId: string,
  nombre: string,
  conHorario = true,
) {
  await crearUsuarioDePrueba({
    id: usuarioId,
    nombre,
    correo: `${nombre.toLowerCase()}@barberly.test`,
  });
  await crearBarberoDePrueba({
    usuarioId,
    barberiaId: CENTRO,
    perfilId,
    nombreVisible: nombre,
    servicioIds: [CORTE],
  });
  if (conHorario) await crearHorarioDePrueba({ barberiaId: CENTRO, perfilBarberoId: perfilId });
}
const crearLuis = (conHorario = true) => crearBarbero(USUARIO_LUIS, LUIS, 'Luis', conHorario);
const crearPedro = () => crearBarbero(USUARIO_PEDRO, PEDRO, 'Pedro');
const crearBruno = () => crearBarbero(USUARIO_BRUNO, BRUNO, 'Bruno');

async function crearClientes(cantidad: number): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < cantidad; n += 1) {
    const id = idPrueba(500 + n);
    await crearUsuarioDePrueba({ id, nombre: `Cliente ${n}`, correo: `cliente${n}@barberly.test` });
    ids.push(id);
  }
  return ids;
}

async function actualizarBarberia(id: string, data: Record<string, unknown>) {
  await baseDatos.barberia.update({ where: { id }, data });
}
async function horarioPropioDeCarlos(diaSemana: number, horaApertura: string, horaCierre: string) {
  await baseDatos.horarioAtencion.updateMany({
    where: { perfilBarberoId: CARLOS, diaSemana },
    data: { horaApertura, horaCierre, inicioPausa: null, finPausa: null },
  });
}
async function membresiaDe(usuarioId: string, estado: 'INVITADO' | 'ACTIVO' | 'INACTIVO') {
  await baseDatos.membresia.update({
    where: { usuarioId_barberiaId: { usuarioId, barberiaId: CENTRO } },
    data: { estado },
  });
}

beforeAll(() => {
  configuracion.PROXIES_CONFIABLES = 1;
});

beforeEach(async () => {
  numeroClave = 0;
  numeroPrueba += 1;
  ip = `10.0.${Math.floor(numeroPrueba / 250)}.${(numeroPrueba % 250) + 1}`;
  await limpiarBase();
  // Centro (propietario; Carlos con Corte y Barba) y Norte (propietaria otra; Andres), publicadas,
  // horario general 09:00-19:00 con pausa 13:00-14:00 los 7 dias; mas el cliente.
  await escenarioBase();
  await crearUsuarioDePrueba({ id: ANA, nombre: 'Ana', correo: 'ana@barberly.test' });
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
  configuracion.PROXIES_CONFIABLES = proxiesOriginales;
  await limpiarBase();
  await baseDatos.$disconnect();
});

describe('HU-RES-01, RES-06: POST /api/v1/citas crea la cita', () => {
  it('PO-01, RN-12: un Corte de 30 min manana 10:00 responde 201 { datos } CONFIRMADA hasta las 10:30 con precio, barbero y barberia', async () => {
    const clave = nuevaClave();
    const respuesta = await reservar(cuerpo({ claveIdempotencia: clave }));

    expect(respuesta.status, JSON.stringify(respuesta.body)).toBe(201);
    expect(Object.keys(respuesta.body)).toEqual(['datos']);
    expect(respuesta.body.datos).toEqual({
      id: expect.any(String),
      estado: 'CONFIRMADA',
      iniciaEn: '2026-12-02T15:00:00.000Z',
      terminaEn: '2026-12-02T15:30:00.000Z',
      duracionReserva: 30,
      precioReserva: '8.00',
      notas: null,
      anticipoVenceEn: null,
      barberia: {
        id: CENTRO,
        nombre: 'Barberia Centro',
        direccion: 'Av. 9 de Octubre 100, Guayaquil',
        telefono: '042345678',
      },
      servicio: { id: CORTE, nombre: 'Corte clasico' },
      barbero: { id: CARLOS, nombreVisible: 'Carlos', urlFoto: null },
      canceladaEn: null,
      motivoCancelacion: null,
      puedeCancelar: true,
    });

    // RN-01: un cliente, una barberia, un barbero, un servicio y un inicio.
    const citas = await baseDatos.cita.findMany();
    expect(citas).toHaveLength(1);
    const cita = citas[0]!;
    expect(cita).toMatchObject({
      id: respuesta.body.datos.id,
      barberiaId: CENTRO,
      clienteId: CLIENTE,
      perfilBarberoId: CARLOS,
      servicioId: CORTE,
      estado: 'CONFIRMADA',
      duracionReserva: 30,
      claveIdempotencia: clave,
      canceladaPorId: null,
      anticipoVenceEn: null,
    });
    expect(cita.iniciaEn).toEqual(local(MIERCOLES, '10:00'));
    expect(cita.terminaEn).toEqual(local(MIERCOLES, '10:30'));
    expect(cita.precioReserva.toFixed(2)).toBe('8.00');
  });

  it('RN-02, RN-03: copia el precio y la duracion vigentes al reservar y no cambian si luego cambia el servicio', async () => {
    await baseDatos.servicio.update({
      where: { id: CORTE },
      data: { precio: '9.50', duracionMinutos: 45 },
    });

    const datos = await crear();
    expect(datos).toMatchObject({
      precioReserva: '9.50',
      duracionReserva: 45,
      terminaEn: iso(MIERCOLES, '10:45'),
    });

    await baseDatos.servicio.update({
      where: { id: CORTE },
      data: { precio: '12.00', duracionMinutos: 60 },
    });
    const cita = await baseDatos.cita.findUniqueOrThrow({ where: { id: datos.id } });
    expect(cita.precioReserva.toFixed(2)).toBe('9.50');
    expect(cita.duracionReserva).toBe(45);
    expect(cita.terminaEn).toEqual(local(MIERCOLES, '10:45'));
  });

  it('RES-12: guarda y devuelve las notas; 200 caracteres se permiten', async () => {
    const notas = 'n'.repeat(200);

    const datos = await crear(cuerpo({ notas }));

    expect(datos.notas).toBe(notas);
    expect((await baseDatos.cita.findUniqueOrThrow({ where: { id: datos.id } })).notas).toBe(notas);
  });

  it('RN-12, RN-34 (CU-07 A2): con anticipoActivo nace PENDIENTE con anticipoVenceEn = ahora + 15 min y ocupa el horario', async () => {
    await actualizarBarberia(CENTRO, { anticipoActivo: true, montoAnticipo: '3.00' });

    const datos = await crear();

    expect(datos.estado).toBe('PENDIENTE');
    expect(datos.anticipoVenceEn).toBe(enMinutos(15).toISOString());
    const cita = await baseDatos.cita.findUniqueOrThrow({ where: { id: datos.id } });
    expect(cita.estado).toBe('PENDIENTE');
    expect(cita.anticipoVenceEn).toEqual(enMinutos(15));
    esperarError(await reservar(cuerpo(), ANA), 409, 'HORARIO_OCUPADO');
  });

  it('D4: puedeCancelar es verdadero con 120 min exactos hasta el inicio y falso con menos (hoy 10:30)', async () => {
    const aLasDoce = await crear(cuerpo({ iniciaEn: iso(HOY, '12:00') }));
    const aLasDiezYMedia = await crear(cuerpo({ iniciaEn: iso(HOY, '10:30') }), ANA);

    expect(aLasDoce.puedeCancelar).toBe(true);
    expect(aLasDiezYMedia.puedeCancelar).toBe(false);
  });

  it('CU-07, §11.7: audita la creacion una vez con el cliente como actor y la barberia', async () => {
    const datos = await crear();

    const registros = await baseDatos.registroAuditoria.findMany({
      where: { entidadId: datos.id },
    });
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ barberiaId: CENTRO, actorId: CLIENTE });
  });
});

describe('RES-06, D2: idempotencia por (clienteId, claveIdempotencia)', () => {
  it('RES-06: repetir la misma clave responde 200 con la misma cita y no crea otra ni otro registro de auditoria', async () => {
    const datos = cuerpo();
    const primera = await crear(datos);

    const segunda = await reservar(datos);

    expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
    expect(segunda.body).toEqual({ datos: primera });
    expect(await baseDatos.cita.count()).toBe(1);
    expect(await baseDatos.registroAuditoria.count({ where: { entidadId: primera.id } })).toBe(1);
  });

  it('D2: con la misma clave y otro cuerpo (otro servicio, sin barbero y en el pasado) responde 200 con la cita original sin revalidar', async () => {
    const clave = nuevaClave();
    const primera = await crear(cuerpo({ claveIdempotencia: clave }));

    const segunda = await reservar(
      cualquiera({
        claveIdempotencia: clave,
        servicioId: BARBA,
        iniciaEn: iso(HOY, '09:00'),
        notas: 'otro cuerpo',
      }),
    );

    expect(segunda.status, JSON.stringify(segunda.body)).toBe(200);
    expect(segunda.body.datos).toEqual(primera);
    expect(segunda.body.datos.servicio.id).toBe(CORTE);
    expect(await baseDatos.cita.count()).toBe(1);
  });

  it('D2: la misma clave de otro cliente no colisiona: crea su propia cita', async () => {
    const clave = nuevaClave();
    const delCliente = await crear(cuerpo({ claveIdempotencia: clave }));

    const deAna = await crear(
      cuerpo({ claveIdempotencia: clave, iniciaEn: iso(MIERCOLES, '11:00') }),
      ANA,
    );

    expect(deAna.id).not.toBe(delCliente.id);
    expect(deAna.iniciaEn).toBe(iso(MIERCOLES, '11:00'));
    expect(await baseDatos.cita.count({ where: { claveIdempotencia: clave } })).toBe(2);
  });

  it('una clave cuya solicitud fue rechazada no queda tomada: el reintento a otra hora crea la cita', async () => {
    await citaDe(CARLOS, MIERCOLES, '10:00');
    const clave = nuevaClave();
    esperarError(await reservar(cuerpo({ claveIdempotencia: clave })), 409, 'HORARIO_OCUPADO');

    const datos = await crear(
      cuerpo({ claveIdempotencia: clave, iniciaEn: iso(MIERCOLES, '11:00') }),
    );

    expect(datos.iniciaEn).toBe(iso(MIERCOLES, '11:00'));
  });
});

describe('PO-02, PO-03, RN-04, RN-11: cruce con otras citas del barbero', () => {
  it('PO-02: con una cita 10:00-10:30 de Carlos, reservar 10:00, 10:15 o 09:45 responde 409 HORARIO_OCUPADO y queda una sola cita', async () => {
    await citaDe(CARLOS, MIERCOLES, '10:00');

    for (const hora of ['10:00', '10:15', '09:45']) {
      esperarError(
        await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, hora) })),
        409,
        'HORARIO_OCUPADO',
      );
    }
    expect(await citasActivasDe(CARLOS)).toHaveLength(1);
    expect(await baseDatos.cita.count({ where: { clienteId: CLIENTE } })).toBe(0);
  });

  it('PO-03, RN-04: entre una cita 09:30-10:00 y otra 10:30-11:00 el hueco 10:00 se ofrece y se reserva (201); luego ya no se ofrece', async () => {
    await citaDe(CARLOS, MIERCOLES, '09:30');
    await citaDe(CARLOS, MIERCOLES, '10:30');
    const disponibilidad = () =>
      request(app)
        .get(`/api/v1/barberias/${CENTRO}/disponibilidad`)
        .query({ servicioId: CORTE, barberoId: CARLOS, fecha: MIERCOLES })
        .set('X-Forwarded-For', ip)
        .set(cabeceraDePrueba(tokenDePrueba(CLIENTE)));
    const inicios = (r: request.Response) =>
      r.body.datos.horarios.map((h: { iniciaEn: string }) => h.iniciaEn);
    expect(inicios(await disponibilidad())).toContain(iso(MIERCOLES, '10:00'));

    const datos = await crear();

    expect(datos).toMatchObject({
      iniciaEn: iso(MIERCOLES, '10:00'),
      terminaEn: iso(MIERCOLES, '10:30'),
    });
    expect(await citasActivasDe(CARLOS)).toHaveLength(3);
    expect(inicios(await disponibilidad())).not.toContain(iso(MIERCOLES, '10:00'));
  });

  it('una PENDIENTE vigente ocupa el horario: HORARIO_OCUPADO', async () => {
    await citaDe(CARLOS, MIERCOLES, '10:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: enMinutos(5),
    });

    esperarError(await reservar(), 409, 'HORARIO_OCUPADO');
  });

  it('N4: una PENDIENTE con anticipoVenceEn igual a ahora todavia ocupa y no se cancela', async () => {
    const pendiente = await citaDe(CARLOS, MIERCOLES, '10:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: local(HOY, '10:00'),
    });

    esperarError(await reservar(), 409, 'HORARIO_OCUPADO');
    expect((await baseDatos.cita.findUniqueOrThrow({ where: { id: pendiente.id } })).estado).toBe(
      'PENDIENTE',
    );
  });

  it('RN-34: con una PENDIENTE vencida en las 10:00, la nueva reserva a las 10:00 tiene exito y la vencida pasa a CANCELADA por el Sistema', async () => {
    const vencida = await citaDe(CARLOS, MIERCOLES, '10:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: enMinutos(-1),
    });

    const datos = await crear();

    expect(datos.estado).toBe('CONFIRMADA');
    const antigua = await baseDatos.cita.findUniqueOrThrow({ where: { id: vencida.id } });
    expect(antigua).toMatchObject({
      estado: 'CANCELADA',
      motivoCancelacion: 'Anticipo vencido',
      canceladaPorId: null,
    });
    expect(antigua.canceladaEn).toEqual(local(HOY, '10:00'));
    // Auditada como anticipo vencido (§8.5): al menos un registro de esa cita.
    expect(await baseDatos.registroAuditoria.count({ where: { entidadId: vencida.id } })).toBe(1);
    expect(await citasActivasDe(CARLOS)).toEqual([expect.objectContaining({ id: datos.id })]);
  });

  it('RN-34: la transaccion cancela todas las PENDIENTE vencidas de Carlos, no las vigentes ni las de otros barberos', async () => {
    const vencidaOtraHora = await citaDe(CARLOS, MIERCOLES, '15:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: enMinutos(-10),
    });
    const vigente = await citaDe(CARLOS, MIERCOLES, '16:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: enMinutos(10),
    });
    const vencidaDeAndres = await citaDe(ANDRES, MIERCOLES, '10:00', {
      estado: 'PENDIENTE',
      anticipoVenceEn: enMinutos(-10),
      barberiaId: NORTE,
      servicioId: CORTE_NORTE,
    });

    await crear();

    const estado = async (id: string) =>
      (await baseDatos.cita.findUniqueOrThrow({ where: { id } })).estado;
    expect(await estado(vencidaOtraHora.id)).toBe('CANCELADA');
    expect(await estado(vigente.id)).toBe('PENDIENTE');
    expect(await estado(vencidaDeAndres.id)).toBe('PENDIENTE');
  });

  it.each(['CANCELADA', 'COMPLETADA', 'AUSENTE'] as const)(
    'una cita %s a las 10:00 no ocupa: el horario se vuelve a tomar (201)',
    async (estado) => {
      await citaDe(CARLOS, MIERCOLES, '10:00', { estado });

      expect((await crear()).iniciaEn).toBe(iso(MIERCOLES, '10:00'));
    },
  );
});

describe('PO-04, RN-06, RN-07: pasado y anticipacion', () => {
  it('PO-04, RN-06: un inicio de hoy ya pasado (09:45) o de ayer responde 422 HORARIO_PASADO', async () => {
    esperarError(await reservar(cuerpo({ iniciaEn: iso(HOY, '09:45') })), 422, 'HORARIO_PASADO');
    esperarError(
      await reservar(cuerpo({ iniciaEn: iso('2026-11-30', '10:00') })),
      422,
      'HORARIO_PASADO',
    );
    expect(await baseDatos.cita.count()).toBe(0);
  });

  it('PO-04, RN-06: a las 10:01 el inicio 10:30 (ahora + 29 min) responde 422 ANTICIPACION_INSUFICIENTE', async () => {
    fijarAhora(local(HOY, '10:01'));

    esperarError(
      await reservar(cuerpo({ iniciaEn: iso(HOY, '10:30') })),
      422,
      'ANTICIPACION_INSUFICIENTE',
    );
  });

  it('PO-04, RN-06: a las 10:00 el inicio 10:30 (ahora + 30 min exactos) responde 201 y 10:15 no', async () => {
    esperarError(
      await reservar(cuerpo({ iniciaEn: iso(HOY, '10:15') })),
      422,
      'ANTICIPACION_INSUFICIENTE',
    );

    expect((await crear(cuerpo({ iniciaEn: iso(HOY, '10:30') }))).iniciaEn).toBe(iso(HOY, '10:30'));
  });

  it('RN-06: con minutosMinAnticipacion 60, 10:45 es insuficiente y 11:00 se permite', async () => {
    await actualizarBarberia(CENTRO, { minutosMinAnticipacion: 60 });

    esperarError(
      await reservar(cuerpo({ iniciaEn: iso(HOY, '10:45') })),
      422,
      'ANTICIPACION_INSUFICIENTE',
    );
    await crear(cuerpo({ iniciaEn: iso(HOY, '11:00') }));
  });

  it('PO-04, RN-07, D5: con diasMaxAnticipacion 30, el 2026-12-31 (hoy + 30) se permite y el 2027-01-01 (31 dias) responde 422 FECHA_DEMASIADO_LEJANA', async () => {
    esperarError(
      await reservar(cuerpo({ iniciaEn: iso('2027-01-01', '09:00') })),
      422,
      'FECHA_DEMASIADO_LEJANA',
    );

    await crear(cuerpo({ iniciaEn: iso('2026-12-31', '18:30') }));
  });

  it('RN-07: con diasMaxAnticipacion 7, el 2026-12-08 se permite y el 2026-12-09 no', async () => {
    await actualizarBarberia(CENTRO, { diasMaxAnticipacion: 7 });

    esperarError(
      await reservar(cuerpo({ iniciaEn: iso('2026-12-09', '10:00') })),
      422,
      'FECHA_DEMASIADO_LEJANA',
    );
    await crear(cuerpo({ iniciaEn: iso('2026-12-08', '10:00') }));
  });

  it('D5: a las 20:00 locales (01:00 UTC del dia siguiente) hoy sigue siendo 2026-12-01: el 2027-01-01 queda fuera', async () => {
    fijarAhora(local(HOY, '20:00'));

    esperarError(
      await reservar(cuerpo({ iniciaEn: iso('2027-01-01', '09:00') })),
      422,
      'FECHA_DEMASIADO_LEJANA',
    );
    await crear(cuerpo({ iniciaEn: iso('2026-12-31', '09:00') }));
  });
});

describe('PO-04, RN-05, RN-26: horario de atencion, bloqueos y dias libres', () => {
  it.each(['06:00', '08:45', '12:45', '13:00', '13:30', '18:45', '19:00'])(
    'PO-04, RN-05: un Corte de 30 min a las %s (fuera del horario o cruzando la pausa o el cierre) responde 422 FUERA_DE_HORARIO',
    async (hora) => {
      esperarError(
        await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, hora) })),
        422,
        'FUERA_DE_HORARIO',
      );
    },
  );

  it('RN-05: 09:00 (apertura), 12:30 (termina al empezar la pausa), 14:00 (fin de la pausa) y 18:30 (termina al cierre) se permiten', async () => {
    // 2 y 2 entre Cliente y Ana para no alcanzar maxCitasActivas 3 (RN-09).
    for (const [hora, usuarioId] of [
      ['09:00', CLIENTE],
      ['12:30', CLIENTE],
      ['14:00', ANA],
      ['18:30', ANA],
    ] as const) {
      await crear(cuerpo({ iniciaEn: iso(MIERCOLES, hora) }), usuarioId);
    }
    expect(await citasActivasDe(CARLOS)).toHaveLength(4);
  });

  it('RN-05: con el horario propio de Carlos 15:00-19:00, las 10:00 son FUERA_DE_HORARIO aunque la barberia abra y las 15:00 se permiten', async () => {
    await horarioPropioDeCarlos(MIERCOLES_DIA, '15:00', '19:00');

    esperarError(await reservar(), 422, 'FUERA_DE_HORARIO');
    await crear(cuerpo({ iniciaEn: iso(MIERCOLES, '15:00') }));
  });

  it('D-31 (N1): sin horario propio ese dia Carlos no trabaja: FUERA_DE_HORARIO; el jueves si', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { perfilBarberoId: CARLOS, diaSemana: MIERCOLES_DIA },
    });

    esperarError(await reservar(), 422, 'FUERA_DE_HORARIO');
    await crear(cuerpo({ iniciaEn: iso(JUEVES, '10:00') }));
  });

  it('RN-05: sin horario general de la barberia ese dia responde FUERA_DE_HORARIO aunque Carlos tenga el suyo', async () => {
    await baseDatos.horarioAtencion.deleteMany({
      where: { barberiaId: CENTRO, perfilBarberoId: null, diaSemana: MIERCOLES_DIA },
    });

    esperarError(await reservar(), 422, 'FUERA_DE_HORARIO');
  });

  it('PO-04, RN-26: con un Bloqueo de Carlos 10:00-12:00, reservar 09:45, 10:00 o 11:30 responde 409 BARBERO_NO_DISPONIBLE', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '10:00'),
      terminaEn: local(MIERCOLES, '12:00'),
    });

    for (const hora of ['09:45', '10:00', '11:30']) {
      esperarError(
        await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, hora) })),
        409,
        'BARBERO_NO_DISPONIBLE',
      );
    }
    expect(await baseDatos.cita.count()).toBe(0);
  });

  it('RN-04: un Bloqueo que termina a las 10:00 deja reservar las 10:00 y uno que empieza a las 10:30 tambien', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '09:00'),
      terminaEn: local(MIERCOLES, '10:00'),
    });
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '10:30'),
      terminaEn: local(MIERCOLES, '12:00'),
    });

    await crear();
  });

  it('RN-26, D6: un cierre de toda la barberia 10:00-11:00 responde BARBERO_NO_DISPONIBLE', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      iniciaEn: local(MIERCOLES, '10:00'),
      terminaEn: local(MIERCOLES, '11:00'),
    });

    esperarError(await reservar(), 409, 'BARBERO_NO_DISPONIBLE');
  });

  it('PO-04, RN-26: un dia libre de varios dias (vacaciones de Carlos) responde BARBERO_NO_DISPONIBLE', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(HOY, '00:00'),
      terminaEn: local('2026-12-05', '00:00'),
      motivo: 'Vacaciones',
    });

    esperarError(await reservar(), 409, 'BARBERO_NO_DISPONIBLE');
    await crear(cuerpo({ iniciaEn: iso('2026-12-05', '10:00') }));
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

    await crear();
  });
});

describe('RN-08, RN-09: reglas del cliente', () => {
  it('RN-08: con una cita 10:00-10:30 en Norte, reservar en Centro 10:00 o 10:15 responde 409 CRUCE_DEL_CLIENTE', async () => {
    await citaEnNorte(MIERCOLES, '10:00');

    esperarError(await reservar(), 409, 'CRUCE_DEL_CLIENTE');
    esperarError(
      await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, '10:15') })),
      409,
      'CRUCE_DEL_CLIENTE',
    );
    expect(await citasActivasDe(CARLOS)).toHaveLength(0);
  });

  it('RN-08, RN-04: las citas contiguas del cliente no se cruzan (10:30 y 09:30 junto a una 10:00-10:30)', async () => {
    await citaEnNorte(MIERCOLES, '10:00');

    await crear(cuerpo({ iniciaEn: iso(MIERCOLES, '10:30') }));
    await crear(cuerpo({ iniciaEn: iso(MIERCOLES, '09:30') }));
  });

  it('RN-08: una PENDIENTE vigente del cliente con otro barbero cruza', async () => {
    await citaEnNorte(MIERCOLES, '10:00', { estado: 'PENDIENTE', anticipoVenceEn: enMinutos(5) });

    esperarError(await reservar(), 409, 'CRUCE_DEL_CLIENTE');
  });

  it('RN-08, RN-34: una PENDIENTE vencida o una CANCELADA del cliente con otro barbero no cruzan', async () => {
    await citaEnNorte(MIERCOLES, '10:00', { estado: 'PENDIENTE', anticipoVenceEn: enMinutos(-1) });
    await citaEnNorte(MIERCOLES, '10:00', { estado: 'CANCELADA' });

    await crear();
  });

  it('RN-09, D-09: con 3 citas futuras activas en Centro, la cuarta responde 409 LIMITE_DE_CITAS', async () => {
    for (const fecha of ['2026-12-03', '2026-12-04', '2026-12-05']) {
      await citaDe(CARLOS, fecha, '10:00', { clienteId: CLIENTE });
    }

    esperarError(await reservar(), 409, 'LIMITE_DE_CITAS');
    expect(await baseDatos.cita.count({ where: { clienteId: CLIENTE } })).toBe(3);
  });

  it('RN-09: con maxCitasActivas 2, la tercera responde LIMITE_DE_CITAS; con una sola previa, la segunda se crea', async () => {
    await actualizarBarberia(CENTRO, { maxCitasActivas: 2 });
    await citaDe(CARLOS, '2026-12-03', '10:00', { clienteId: CLIENTE });

    await crear();
    esperarError(
      await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, '11:00') })),
      409,
      'LIMITE_DE_CITAS',
    );
  });

  it('RN-09: una PENDIENTE vigente cuenta para el limite', async () => {
    await citaDe(CARLOS, '2026-12-03', '10:00', { clienteId: CLIENTE });
    await citaDe(CARLOS, '2026-12-04', '10:00', { clienteId: CLIENTE });
    await citaDe(CARLOS, '2026-12-05', '10:00', {
      clienteId: CLIENTE,
      estado: 'PENDIENTE',
      anticipoVenceEn: enMinutos(5),
    });

    esperarError(await reservar(), 409, 'LIMITE_DE_CITAS');
  });

  it('RN-09: no cuentan las citas pasadas, las CANCELADA ni COMPLETADA, ni las de otra barberia', async () => {
    await citaDe(CARLOS, HOY, '09:00', { clienteId: CLIENTE }); // CONFIRMADA ya pasada
    await citaDe(CARLOS, '2026-12-03', '10:00', { clienteId: CLIENTE, estado: 'CANCELADA' });
    await citaDe(CARLOS, '2026-12-04', '10:00', { clienteId: CLIENTE, estado: 'COMPLETADA' });
    await citaEnNorte('2026-12-03', '10:00');
    await citaEnNorte('2026-12-04', '10:00');
    await citaEnNorte('2026-12-05', '10:00');
    await citaDe(CARLOS, '2026-12-06', '10:00', { clienteId: CLIENTE });
    await citaDe(CARLOS, '2026-12-07', '10:00', { clienteId: CLIENTE });

    // En Centro solo hay 2 futuras activas: la tercera se permite.
    await crear();
  });
});

describe('CU-07 A3, RES-02: Cualquiera disponible (sin barberoId)', () => {
  it('CU-07 A3: asigna al barbero libre con menos citas ese dia y la respuesta trae su barbero', async () => {
    await crearLuis();
    await citaDe(CARLOS, MIERCOLES, '15:00');
    await citaDe(CARLOS, MIERCOLES, '16:00');
    await citaDe(LUIS, MIERCOLES, '15:00');

    const datos = await crear(cualquiera());

    expect(datos.barbero).toEqual({ id: LUIS, nombreVisible: 'Luis', urlFoto: null });
    const cita = await baseDatos.cita.findUniqueOrThrow({ where: { id: datos.id } });
    expect(cita.perfilBarberoId).toBe(LUIS);
  });

  it('CU-07 A3: en empate asigna el de menor id (Bruno 300 antes que Carlos 301 y Luis 303)', async () => {
    await crearLuis();
    await crearBruno();

    expect((await crear(cualquiera())).barbero.id).toBe(BRUNO);
  });

  it('CU-07 A3: solo cuentan las citas de ese dia local; las de otros dias no desempatan', async () => {
    await crearLuis();
    await citaDe(CARLOS, MIERCOLES, '15:00');
    for (const fecha of ['2026-12-03', '2026-12-04', '2026-12-05']) {
      await citaDe(LUIS, fecha, '10:00');
    }

    expect((await crear(cualquiera())).barbero.id).toBe(LUIS);
  });

  it('CU-07 A3: un barbero ocupado a esa hora no se asigna aunque tenga menos citas', async () => {
    await crearLuis();
    await citaDe(CARLOS, MIERCOLES, '10:00');
    await citaDe(LUIS, MIERCOLES, '15:00');
    await citaDe(LUIS, MIERCOLES, '16:00');

    expect((await crear(cualquiera())).barbero.id).toBe(LUIS);
  });

  it('CU-07 A3: un barbero con Bloqueo o sin horario propio ese dia no se asigna', async () => {
    await crearLuis();
    await crearPedro();
    await citaDe(CARLOS, MIERCOLES, '15:00');
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: LUIS,
      iniciaEn: local(MIERCOLES, '09:00'),
      terminaEn: local(MIERCOLES, '12:00'),
    });
    await baseDatos.horarioAtencion.deleteMany({
      where: { perfilBarberoId: PEDRO, diaSemana: MIERCOLES_DIA },
    });

    expect((await crear(cualquiera())).barbero.id).toBe(CARLOS);
  });

  it('RN-23: solo considera a quienes ofrecen el servicio (Luis no ofrece Barba)', async () => {
    await crearLuis();
    await citaDe(CARLOS, MIERCOLES, '15:00');

    expect((await crear(cualquiera({ servicioId: BARBA }))).barbero.id).toBe(CARLOS);
    // Carlos ocupado a las 10:00 y Luis no ofrece Barba: nadie puede atender.
    esperarError(await reservar(cualquiera({ servicioId: BARBA }), ANA), 409, 'HORARIO_OCUPADO');
  });

  it('D-33: un barbero con Usuario inactivo no se asigna aunque tenga menos citas', async () => {
    await crearLuis();
    await citaDe(CARLOS, MIERCOLES, '15:00');
    await baseDatos.usuario.update({ where: { id: USUARIO_LUIS }, data: { activo: false } });

    expect((await crear(cualquiera())).barbero.id).toBe(CARLOS);
  });

  it('N3: un barbero con membresia INVITADO o INACTIVO no se asigna', async () => {
    await crearLuis();
    await crearPedro();
    await citaDe(CARLOS, MIERCOLES, '15:00');
    await membresiaDe(USUARIO_LUIS, 'INVITADO');
    await membresiaDe(USUARIO_PEDRO, 'INACTIVO');

    expect((await crear(cualquiera())).barbero.id).toBe(CARLOS);
  });

  it('con todos los candidatos ocupados a esa hora responde 409 HORARIO_OCUPADO', async () => {
    await crearLuis();
    await citaDe(CARLOS, MIERCOLES, '10:00');
    await citaDe(LUIS, MIERCOLES, '10:00');

    esperarError(await reservar(cualquiera()), 409, 'HORARIO_OCUPADO');
  });
});

describe('D-31, N2: cualquier usuario autenticado reserva como cliente', () => {
  it.each([
    ['el barbero Carlos en su propia barberia (con Luis)', IDS_PRUEBA.barbero, LUIS],
    ['el propietario de Centro', IDS_PRUEBA.propietario, CARLOS],
    ['la propietaria de Norte', IDS_PRUEBA.propietarioOtra, CARLOS],
    ['el barbero de Norte', IDS_PRUEBA.barberoOtra, CARLOS],
  ])('%s recibe 201 y queda como cliente de la cita', async (_rol, usuarioId, barberoId) => {
    await crearLuis();

    const datos = await crear(cuerpo({ barberoId }), usuarioId);

    const cita = await baseDatos.cita.findUniqueOrThrow({ where: { id: datos.id } });
    expect(cita.clienteId).toBe(usuarioId);
    expect(cita.perfilBarberoId).toBe(barberoId);
  });
});

describe('SEG-02, D7, D-33, N3: NO_ENCONTRADO, RECURSO_INACTIVO y SERVICIO_NO_OFRECIDO', () => {
  // Cada 404 compara contra un control en 201 para no pasar mientras la ruta no exista.
  it.each([
    ['una barberia inexistente', { barberiaId: idPrueba(999) }],
    ['el servicio de Norte en Centro (no SERVICIO_NO_OFRECIDO)', { servicioId: CORTE_NORTE }],
    ['un servicioId inexistente', { servicioId: idPrueba(998) }],
    ['el barbero de Norte en Centro (no SERVICIO_NO_OFRECIDO)', { barberoId: ANDRES }],
    ['un barberoId inexistente', { barberoId: idPrueba(997) }],
    ['el id del Usuario del barbero en vez de su PerfilBarbero', { barberoId: IDS_PRUEBA.barbero }],
    [
      'Aislamiento: el servicio de Centro en Norte',
      { barberiaId: NORTE, servicioId: CORTE, barberoId: ANDRES },
    ],
    [
      'Aislamiento: el barbero de Centro en Norte',
      { barberiaId: NORTE, servicioId: CORTE_NORTE, barberoId: CARLOS },
    ],
  ])('SEG-02: %s responde 404 NO_ENCONTRADO y no crea la cita', async (_caso, cambios) => {
    await control();

    esperarNoEncontrado(await reservar(cuerpo(cambios)));
    expect(await baseDatos.cita.count()).toBe(1);
  });

  it('SEG-02: el servicio de Norte en Centro sin barberoId responde NO_ENCONTRADO', async () => {
    await control();

    esperarNoEncontrado(await reservar(cualquiera({ servicioId: CORTE_NORTE })));
  });

  it.each([
    ['cliente', CLIENTE],
    ['propietario', IDS_PRUEBA.propietario],
    ['barbero ACTIVO', IDS_PRUEBA.barbero],
  ])('D7: barberia no publicada: NO_ENCONTRADO tambien para el %s', async (_rol, usuarioId) => {
    await control();
    await actualizarBarberia(CENTRO, { publicada: false });

    esperarNoEncontrado(await reservar(cuerpo({ barberoId: CARLOS }), usuarioId));
  });

  it.each([
    ['cliente', CLIENTE],
    ['propietario', IDS_PRUEBA.propietario],
    ['barbero ACTIVO', IDS_PRUEBA.barbero],
  ])(
    'D7: barberia inactiva (aunque publicada): NO_ENCONTRADO tambien para el %s',
    async (_rol, usuarioId) => {
      await control();
      await actualizarBarberia(CENTRO, { activo: false });

      esperarNoEncontrado(await reservar(cuerpo(), usuarioId));
    },
  );

  it('D-33: un barbero con Usuario inactivo y membresia ACTIVO responde NO_ENCONTRADO y sus citas siguen igual', async () => {
    await control(); // cita de Ana con Carlos a las 15:00
    await baseDatos.usuario.update({ where: { id: IDS_PRUEBA.barbero }, data: { activo: false } });

    esperarNoEncontrado(await reservar());
    expect(await citasActivasDe(CARLOS)).toEqual([
      expect.objectContaining({ estado: 'CONFIRMADA', iniciaEn: local(MIERCOLES, '15:00') }),
    ]);
  });

  it('N3: un barbero con membresia INVITADO responde NO_ENCONTRADO (ACTIVO da 201)', async () => {
    await crearLuis();
    await crear(cuerpo({ barberoId: LUIS, iniciaEn: iso(MIERCOLES, '15:00') }), ANA);
    await membresiaDe(USUARIO_LUIS, 'INVITADO');

    esperarNoEncontrado(await reservar(cuerpo({ barberoId: LUIS })));
  });

  it('N3: un barbero con membresia INACTIVO responde 409 RECURSO_INACTIVO', async () => {
    await membresiaDe(IDS_PRUEBA.barbero, 'INACTIVO');

    esperarError(await reservar(), 409, 'RECURSO_INACTIVO');
  });

  it('un servicio inactivo responde 409 RECURSO_INACTIVO, con y sin barberoId', async () => {
    await baseDatos.servicio.update({ where: { id: CORTE }, data: { activo: false } });

    esperarError(await reservar(), 409, 'RECURSO_INACTIVO');
    esperarError(await reservar(cualquiera()), 409, 'RECURSO_INACTIVO');
  });

  it('RN-23: Carlos sin Barba responde 422 SERVICIO_NO_OFRECIDO', async () => {
    await baseDatos.servicioBarbero.delete({
      where: { perfilBarberoId_servicioId: { perfilBarberoId: CARLOS, servicioId: BARBA } },
    });

    esperarError(await reservar(cuerpo({ servicioId: BARBA })), 422, 'SERVICIO_NO_OFRECIDO');
  });
});

describe('§8.5: orden de validacion ante varios fallos', () => {
  it('1 antes que 2 y 3: sin token, con campo extra y barberia inexistente responde 401', async () => {
    const respuesta = await request(app)
      .post(RUTA)
      .set('X-Forwarded-For', ip)
      .send({ ...cuerpo({ barberiaId: idPrueba(999) }), extra: true });

    esperarError(respuesta, 401, 'AUTENTICACION_REQUERIDA');
  });

  it('2 antes que 3: una barberia inexistente con un campo extra responde 422 DATOS_INVALIDOS', async () => {
    esperarInvalido(await reservar({ ...cuerpo({ barberiaId: idPrueba(999) }), extra: true }));
  });

  it('N3: NO_ENCONTRADO antes que RECURSO_INACTIVO: servicio inactivo con el barbero de Norte', async () => {
    await control();
    await baseDatos.servicio.update({ where: { id: CORTE }, data: { activo: false } });

    esperarNoEncontrado(await reservar(cuerpo({ barberoId: ANDRES })));
  });

  it('N3: RECURSO_INACTIVO antes que SERVICIO_NO_OFRECIDO: Carlos INACTIVO y sin Barba', async () => {
    await baseDatos.servicioBarbero.delete({
      where: { perfilBarberoId_servicioId: { perfilBarberoId: CARLOS, servicioId: BARBA } },
    });
    await membresiaDe(IDS_PRUEBA.barbero, 'INACTIVO');

    esperarError(await reservar(cuerpo({ servicioId: BARBA })), 409, 'RECURSO_INACTIVO');
  });

  it('4 antes que 5: un servicio no ofrecido en el pasado responde SERVICIO_NO_OFRECIDO', async () => {
    await baseDatos.servicioBarbero.delete({
      where: { perfilBarberoId_servicioId: { perfilBarberoId: CARLOS, servicioId: BARBA } },
    });

    esperarError(
      await reservar(cuerpo({ servicioId: BARBA, iniciaEn: iso(HOY, '09:00') })),
      422,
      'SERVICIO_NO_OFRECIDO',
    );
  });

  it('5 antes que 6: hoy a las 07:00 (pasado y fuera de horario) responde HORARIO_PASADO', async () => {
    esperarError(await reservar(cuerpo({ iniciaEn: iso(HOY, '07:00') })), 422, 'HORARIO_PASADO');
  });

  it('5 antes que 6: el 2027-01-01 a las 07:00 (lejana y fuera de horario) responde FECHA_DEMASIADO_LEJANA', async () => {
    esperarError(
      await reservar(cuerpo({ iniciaEn: iso('2027-01-01', '07:00') })),
      422,
      'FECHA_DEMASIADO_LEJANA',
    );
  });

  it('6 antes que 7: fuera de horario dentro de un dia bloqueado responde FUERA_DE_HORARIO', async () => {
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '00:00'),
      terminaEn: local(JUEVES, '00:00'),
    });

    esperarError(
      await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, '08:00') })),
      422,
      'FUERA_DE_HORARIO',
    );
  });

  it('7 antes que 8: una cita ya existente bajo un Bloqueo posterior responde BARBERO_NO_DISPONIBLE', async () => {
    await citaDe(CARLOS, MIERCOLES, '10:00');
    await crearBloqueoDePrueba({
      barberiaId: CENTRO,
      perfilBarberoId: CARLOS,
      iniciaEn: local(MIERCOLES, '10:00'),
      terminaEn: local(MIERCOLES, '11:00'),
    });

    esperarError(await reservar(), 409, 'BARBERO_NO_DISPONIBLE');
  });

  it('8 antes que 9: horario de Carlos ocupado y cruce del cliente responde HORARIO_OCUPADO', async () => {
    await citaDe(CARLOS, MIERCOLES, '10:00');
    await citaEnNorte(MIERCOLES, '10:00');

    esperarError(await reservar(), 409, 'HORARIO_OCUPADO');
  });

  it('9: con cruce del cliente y el limite alcanzado responde CRUCE_DEL_CLIENTE', async () => {
    for (const fecha of ['2026-12-03', '2026-12-04', '2026-12-05']) {
      await citaDe(CARLOS, fecha, '10:00', { clienteId: CLIENTE });
    }
    await citaEnNorte(MIERCOLES, '10:00');

    esperarError(await reservar(), 409, 'CRUCE_DEL_CLIENTE');
  });
});

describe('Validacion del cuerpo (DATOS_INVALIDOS, RN-10, D6)', () => {
  const valido = () => cuerpo({ claveIdempotencia: CLAVE_FIJA });
  it.each([
    ['campo extra precioReserva', () => ({ ...valido(), precioReserva: '0.01' })],
    ['campo extra clienteId', () => ({ ...valido(), clienteId: ANA })],
    ['campo extra estado', () => ({ ...valido(), estado: 'CONFIRMADA' })],
    ['cuerpo vacio', () => ({})],
    ['falta barberiaId', () => sinCampo('barberiaId')],
    ['barberiaId que no es UUID', () => ({ ...valido(), barberiaId: 'centro' })],
    ['falta servicioId', () => sinCampo('servicioId')],
    ['servicioId que no es UUID', () => ({ ...valido(), servicioId: 'corte' })],
    ['barberoId que no es UUID', () => ({ ...valido(), barberoId: 'carlos' })],
    ['barberoId vacio', () => ({ ...valido(), barberoId: '' })],
    ['falta iniciaEn', () => sinCampo('iniciaEn')],
    ['iniciaEn que no es fecha', () => ({ ...valido(), iniciaEn: 'manana a las 10' })],
    ['iniciaEn solo con fecha', () => ({ ...valido(), iniciaEn: MIERCOLES })],
    [
      'RN-10: iniciaEn 10:05 fuera del bloque de 15',
      () => ({ ...valido(), iniciaEn: iso(MIERCOLES, '10:05') }),
    ],
    ['RN-10: iniciaEn 10:07', () => ({ ...valido(), iniciaEn: iso(MIERCOLES, '10:07') })],
    ['RN-10: iniciaEn 10:00:30', () => ({ ...valido(), iniciaEn: '2026-12-02T15:00:30.000Z' })],
    ['falta claveIdempotencia', () => sinCampo('claveIdempotencia')],
    ['claveIdempotencia que no es UUID', () => ({ ...valido(), claveIdempotencia: 'reintento-1' })],
    ['claveIdempotencia vacia', () => ({ ...valido(), claveIdempotencia: '' })],
    ['RES-12: notas de 201 caracteres', () => ({ ...valido(), notas: 'n'.repeat(201) })],
    ['notas que no son texto', () => ({ ...valido(), notas: 123 })],
  ])('%s responde 422 DATOS_INVALIDOS y no crea la cita', async (_caso, armar) => {
    esperarInvalido(await reservar(armar()));
    expect(await baseDatos.cita.count()).toBe(0);
  });

  it('D6: un inicio fuera del bloque de 15 minutos indica el campo iniciaEn en detalles', async () => {
    const respuesta = await reservar(cuerpo({ iniciaEn: iso(MIERCOLES, '10:05') }));

    esperarInvalido(respuesta);
    expect(respuesta.body.error.detalles).toEqual(
      expect.arrayContaining([expect.objectContaining({ campo: 'iniciaEn' })]),
    );
  });
});

describe('Sesion (Pub, D-31)', () => {
  it('sin token responde 401 AUTENTICACION_REQUERIDA', async () => {
    const respuesta = await request(app).post(RUTA).set('X-Forwarded-For', ip).send(cuerpo());

    esperarError(respuesta, 401, 'AUTENTICACION_REQUERIDA');
    expect(await baseDatos.cita.count()).toBe(0);
  });

  it('con el token de acceso vencido responde 401 TOKEN_VENCIDO', async () => {
    const respuesta = await request(app)
      .post(RUTA)
      .set('X-Forwarded-For', ip)
      .set(cabeceraDePrueba(tokenDePrueba(CLIENTE, -1)))
      .send(cuerpo());

    esperarError(respuesta, 401, 'TOKEN_VENCIDO');
  });
});

describe('PO-05, HU-RES-04, RN-11, D-19: concurrencia real', () => {
  const OPCIONES_LENTAS = 60_000; // ms por caso: crea usuarios y espera transacciones en fila

  it(
    'PO-05: 20 solicitudes simultaneas de clientes distintos al mismo barbero y hora: una 201, 19 HORARIO_OCUPADO y una sola cita',
    async () => {
      const clientes = await crearClientes(20);

      const respuestas = await Promise.all(clientes.map((id) => reservar(cuerpo(), id)));

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
      const ocupados = respuestas.filter((r) => r.body.error?.codigo === 'HORARIO_OCUPADO');
      expect(ocupados).toHaveLength(19);
      expect(ocupados.every((r) => r.status === 409)).toBe(true);
      expect(await baseDatos.cita.count({ where: { iniciaEn: local(MIERCOLES, '10:00') } })).toBe(
        1,
      );
    },
    OPCIONES_LENTAS,
  );

  it(
    'PO-05: 20 solicitudes simultaneas que se solapan en parte (10:00 y 10:15) dejan una sola cita de Carlos',
    async () => {
      const clientes = await crearClientes(20);

      const respuestas = await Promise.all(
        clientes.map((id, n) =>
          reservar(cuerpo({ iniciaEn: iso(MIERCOLES, n % 2 === 0 ? '10:00' : '10:15') }), id),
        ),
      );

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
      expect(respuestas.filter((r) => r.body.error?.codigo === 'HORARIO_OCUPADO')).toHaveLength(19);
      expect(await citasActivasDe(CARLOS)).toHaveLength(1);
    },
    OPCIONES_LENTAS,
  );

  it(
    'CU-07 A3: 6 clientes simultaneos sin barberoId con 3 barberos libres: 3 citas sin cruces, una por barbero, y 3 HORARIO_OCUPADO',
    async () => {
      await crearLuis();
      await crearPedro();
      const clientes = await crearClientes(6);

      const respuestas = await Promise.all(clientes.map((id) => reservar(cualquiera(), id)));

      const creadas = respuestas.filter((r) => r.status === 201);
      expect(creadas).toHaveLength(3);
      expect(new Set(creadas.map((r) => r.body.datos.barbero.id))).toEqual(
        new Set([CARLOS, LUIS, PEDRO]),
      );
      expect(respuestas.filter((r) => r.body.error?.codigo === 'HORARIO_OCUPADO')).toHaveLength(3);
      const citas = await baseDatos.cita.findMany({
        where: { iniciaEn: local(MIERCOLES, '10:00') },
      });
      expect(new Set(citas.map((c) => c.perfilBarberoId))).toEqual(new Set([CARLOS, LUIS, PEDRO]));
      expect(citas).toHaveLength(3);
    },
    OPCIONES_LENTAS,
  );

  it(
    'RN-08: el mismo cliente con 3 solicitudes simultaneas a las 10:00 con Carlos, Luis y Pedro: una 201 y 2 CRUCE_DEL_CLIENTE',
    async () => {
      await crearLuis();
      await crearPedro();

      const respuestas = await Promise.all(
        [CARLOS, LUIS, PEDRO].map((barberoId) => reservar(cuerpo({ barberoId }))),
      );

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
      expect(respuestas.filter((r) => r.body.error?.codigo === 'CRUCE_DEL_CLIENTE')).toHaveLength(
        2,
      );
      expect(await baseDatos.cita.count({ where: { clienteId: CLIENTE } })).toBe(1);
    },
    OPCIONES_LENTAS,
  );

  it(
    'RN-09: con maxCitasActivas 1, 3 solicitudes simultaneas del mismo cliente con barberos distintos: una 201 y 2 LIMITE_DE_CITAS',
    async () => {
      await actualizarBarberia(CENTRO, { maxCitasActivas: 1 });
      await crearLuis();
      await crearPedro();

      const respuestas = await Promise.all([
        reservar(cuerpo({ barberoId: CARLOS, iniciaEn: iso(MIERCOLES, '10:00') })),
        reservar(cuerpo({ barberoId: LUIS, iniciaEn: iso(MIERCOLES, '11:00') })),
        reservar(cuerpo({ barberoId: PEDRO, iniciaEn: iso(MIERCOLES, '12:00') })),
      ]);

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
      expect(respuestas.filter((r) => r.body.error?.codigo === 'LIMITE_DE_CITAS')).toHaveLength(2);
      expect(await baseDatos.cita.count({ where: { clienteId: CLIENTE } })).toBe(1);
    },
    OPCIONES_LENTAS,
  );

  it(
    'RN-34: 10 clientes simultaneos sobre una PENDIENTE vencida: una 201, 9 HORARIO_OCUPADO y la vencida queda CANCELADA',
    async () => {
      const vencida = await citaDe(CARLOS, MIERCOLES, '10:00', {
        estado: 'PENDIENTE',
        anticipoVenceEn: enMinutos(-1),
      });
      const clientes = await crearClientes(10);

      const respuestas = await Promise.all(clientes.map((id) => reservar(cuerpo(), id)));

      expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
      expect(respuestas.filter((r) => r.body.error?.codigo === 'HORARIO_OCUPADO')).toHaveLength(9);
      expect((await baseDatos.cita.findUniqueOrThrow({ where: { id: vencida.id } })).estado).toBe(
        'CANCELADA',
      );
      expect(await citasActivasDe(CARLOS)).toHaveLength(1);
    },
    OPCIONES_LENTAS,
  );

  it(
    'RES-06, D2: 10 solicitudes simultaneas del mismo cliente con la misma clave y el mismo cuerpo: una 201, 9 200 con la misma cita, ningun HORARIO_OCUPADO y una sola fila',
    async () => {
      const datos = cuerpo();

      const respuestas = await Promise.all(Array.from({ length: 10 }, () => reservar(datos)));

      const estados = respuestas.map((r) => r.status);
      const detalle = JSON.stringify(respuestas.map((r) => [r.status, r.body.error?.codigo]));
      expect(
        respuestas.filter((r) => r.body.error?.codigo === 'HORARIO_OCUPADO'),
        detalle,
      ).toHaveLength(0);
      expect(
        estados.filter((estado) => estado === 201),
        detalle,
      ).toHaveLength(1);
      expect(
        estados.filter((estado) => estado === 200),
        detalle,
      ).toHaveLength(9);
      const creada = respuestas.find((r) => r.status === 201)!.body.datos;
      expect(respuestas.every((r) => r.body.datos?.id === creada.id)).toBe(true);
      expect(
        await baseDatos.cita.count({
          where: { clienteId: CLIENTE, claveIdempotencia: datos.claveIdempotencia as string },
        }),
      ).toBe(1);
      expect(await baseDatos.cita.count()).toBe(1);
      expect(await baseDatos.registroAuditoria.count({ where: { entidadId: creada.id } })).toBe(1);
    },
    OPCIONES_LENTAS,
  );
});

describe('§10.7: documentacion de POST /citas', () => {
  it('GET /api/v1/documentacion incluye POST /citas con token de acceso y 200, 201, 401, 404, 409 y 422', async () => {
    const { body } = await request(app).get('/api/v1/documentacion');

    const operacion = body.paths['/citas']?.post;
    expect(operacion).toBeDefined();
    expect(Object.keys(operacion.responses)).toEqual(
      expect.arrayContaining(['200', '201', '401', '404', '409', '422']),
    );
    expect(operacion.security).toEqual([{ bearer: [] }]);
  });
});
