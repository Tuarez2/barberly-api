// Errores de PostgreSQL traducidos por los servicios (D-19, RN-04, skill reservas-concurrencia).
// Los errores simulados copian la forma real de @prisma/adapter-pg 7.10: el adaptador convierte el
// error del driver en { originalCode, originalMessage, kind, ... } y el cliente lo envuelve en un
// PrismaClientKnownRequestError con meta.driverAdapterError (un DriverAdapterError con esa causa).
// Para kind "postgres" el codigo es P2010 en consultas crudas y P2039 en las del cliente.
import { describe, expect, it } from 'vitest';

import { Prisma } from '../generado/prisma/client';
import { esCruceDeCitas, esDuplicado, esReintentable } from './errores-base-datos';

const VERSION = Prisma.prismaVersion.client;

function errorConocido(codigo: string, mensaje: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(mensaje, {
    code: codigo,
    clientVersion: VERSION,
    meta,
  });
}

function errorDelAdaptador(causa: Record<string, unknown>) {
  const error = new Error(String(causa.originalMessage ?? causa.kind), { cause: causa });
  error.name = 'DriverAdapterError';
  return error;
}

// Error del driver sin mapeo propio (kind "postgres"), como sale de mapDriverError por defecto.
function errorPostgres(
  codigoPrisma: 'P2010' | 'P2039',
  codigo: string,
  mensaje: string,
  detalle?: string,
) {
  const causa = {
    originalCode: codigo,
    originalMessage: mensaje,
    kind: 'postgres',
    code: codigo,
    severity: 'ERROR',
    message: mensaje,
    detail: detalle,
    column: undefined,
    hint: undefined,
  };
  const prefijo = codigoPrisma === 'P2010' ? 'Raw query failed' : 'Database error';
  return errorConocido(codigoPrisma, `${prefijo}. Code: \`${codigo}\`. Message: \`${mensaje}\``, {
    driverAdapterError: errorDelAdaptador(causa),
  });
}

const MENSAJE_CRUCE =
  'conflicting key value violates exclusion constraint "ex_citas_barbero_sin_cruce"';
const DETALLE_CRUCE =
  'Key ("perfilBarberoId", tstzrange("iniciaEn", "terminaEn", \'[)\'::text))=(...) conflicts with existing key (...).';
const MENSAJE_INTERBLOQUEO = 'deadlock detected';

// P2028: tiempo de la transaccion interactiva agotado (no pasa por el adaptador).
const tiempoAgotado = () =>
  errorConocido(
    'P2028',
    'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.',
  );
// P2034: TransactionWriteConflict, que el adaptador usa para 40001 y 40P01 en consultas del cliente.
const conflictoDeEscritura = (codigo: '40001' | '40P01') =>
  errorConocido(
    'P2034',
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    {
      driverAdapterError: errorDelAdaptador({
        originalCode: codigo,
        originalMessage: codigo === '40P01' ? MENSAJE_INTERBLOQUEO : 'could not serialize access',
        kind: 'TransactionWriteConflict',
      }),
    },
  );
// 40P01 en una consulta cruda (SELECT ... FOR UPDATE con $queryRaw): llega como P2010.
const interbloqueoCrudo = () => errorPostgres('P2010', '40P01', MENSAJE_INTERBLOQUEO);
const cruceCrudo = () => errorPostgres('P2010', '23P01', MENSAJE_CRUCE, DETALLE_CRUCE);
const cruceDelCliente = () => errorPostgres('P2039', '23P01', MENSAJE_CRUCE, DETALLE_CRUCE);
const duplicado = () =>
  errorConocido(
    'P2002',
    'Unique constraint failed on the fields: (`clienteId`,`claveIdempotencia`)',
    {
      modelName: 'Cita',
      driverAdapterError: errorDelAdaptador({
        originalCode: '23505',
        originalMessage: 'duplicate key value violates unique constraint',
        kind: 'UniqueConstraintViolation',
        constraint: { fields: ['clienteId', 'claveIdempotencia'] },
      }),
    },
  );
// Violacion de llave foranea (23503), otro error que no se reintenta.
const llaveForanea = () =>
  errorConocido(
    'P2003',
    'Foreign key constraint violated on the constraint: `citas_servicioId_fkey`',
    {
      driverAdapterError: errorDelAdaptador({
        originalCode: '23503',
        originalMessage: 'insert or update on table "citas" violates foreign key constraint',
        kind: 'ForeignKeyConstraintViolation',
        constraint: { index: 'citas_servicioId_fkey' },
      }),
    },
  );

describe('D-19, reservas-concurrencia: esReintentable', () => {
  it('P2028: la transaccion agotada se reintenta', () => {
    expect(esReintentable(tiempoAgotado())).toBe(true);
  });

  it('P2034: el conflicto de escritura (40001) y el interbloqueo (40P01) del cliente se reintentan', () => {
    expect(esReintentable(conflictoDeEscritura('40001'))).toBe(true);
    expect(esReintentable(conflictoDeEscritura('40P01'))).toBe(true);
  });

  it('40P01 envuelto como P2010 con meta.driverAdapterError.cause.originalCode se reintenta', () => {
    expect(esReintentable(interbloqueoCrudo())).toBe(true);
  });

  it('la violacion EXCLUDE 23P01 no se reintenta: es HORARIO_OCUPADO', () => {
    expect(esReintentable(cruceCrudo())).toBe(false);
    expect(esReintentable(cruceDelCliente())).toBe(false);
  });

  it('un error cualquiera no es reintentable: P2002, P2003, un P2010 sin meta, un Error y valores que no son errores', () => {
    expect(esReintentable(duplicado())).toBe(false);
    expect(esReintentable(llaveForanea())).toBe(false);
    expect(esReintentable(errorConocido('P2010', 'Raw query failed. Code: `N/A`'))).toBe(false);
    expect(esReintentable(new Error('deadlock detected'))).toBe(false);
    expect(esReintentable(undefined)).toBe(false);
    expect(esReintentable(null)).toBe(false);
    expect(esReintentable('P2034')).toBe(false);
  });

  it('un objeto con la forma de Prisma que no es PrismaClientKnownRequestError no se reintenta', () => {
    const imitacion = {
      code: 'P2034',
      meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
    };
    expect(esReintentable(imitacion)).toBe(false);
  });
});

describe('RN-04: esCruceDeCitas (ex_citas_barbero_sin_cruce)', () => {
  it('reconoce el 23P01 de ex_citas_barbero_sin_cruce en consultas del cliente (P2039) y crudas (P2010)', () => {
    expect(esCruceDeCitas(cruceDelCliente())).toBe(true);
    expect(esCruceDeCitas(cruceCrudo())).toBe(true);
  });

  it('no confunde con cruce el interbloqueo, la transaccion agotada ni el indice unico', () => {
    expect(esCruceDeCitas(interbloqueoCrudo())).toBe(false);
    expect(esCruceDeCitas(conflictoDeEscritura('40P01'))).toBe(false);
    expect(esCruceDeCitas(tiempoAgotado())).toBe(false);
    expect(esCruceDeCitas(duplicado())).toBe(false);
    expect(esCruceDeCitas(llaveForanea())).toBe(false);
  });

  it('no es cruce un error sin meta, un Error con el mensaje de la restriccion ni una imitacion', () => {
    expect(esCruceDeCitas(errorConocido('P2039', 'Database error. Code: `N/A`'))).toBe(false);
    expect(esCruceDeCitas(new Error(MENSAJE_CRUCE))).toBe(false);
    expect(
      esCruceDeCitas({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '23P01' } } },
      }),
    ).toBe(false);
    expect(esCruceDeCitas(undefined)).toBe(false);
  });
});

describe('esDuplicado', () => {
  it('solo el P2002 es duplicado', () => {
    expect(esDuplicado(duplicado())).toBe(true);
    expect(esDuplicado(cruceDelCliente())).toBe(false);
    expect(esDuplicado(new Error('duplicate key'))).toBe(false);
  });
});
