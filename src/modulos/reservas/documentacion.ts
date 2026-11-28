// Rutas de reservas para OpenAPI (§10.7). T3.2: disponibilidad (RES-03, RES-04). T3.3: POST /citas.
import { z } from 'zod';

import type { RegistrarDocumentacion } from '../../compartido/documentacion';
import { respuestaError, SEGURIDAD_BEARER } from '../../compartido/documentacion';
import {
  esquemaConsultaDiasDisponibles,
  esquemaConsultaDisponibilidad,
  esquemaCrearCitaDoc,
  esquemaRespuestaCitaDoc,
  esquemaRespuestaDiasDisponiblesDoc,
  esquemaRespuestaDisponibilidadDoc,
} from './esquemas';

const parametrosBarberia = z.object({
  id: z.string().meta({ description: 'Id de la barbería (UUID); otro texto responde 404' }),
});

const ALGORITMO =
  'Horario propio del barbero recortado al general de la barbería (RN-05; sin horario propio ese día no trabaja, D-31), menos las pausas, los bloqueos suyos y de toda la barbería (RN-26) y sus citas PENDIENTE y CONFIRMADA en intervalo semiabierto (RN-04); una PENDIENTE con `anticipoVenceEn` vencido no ocupa y no se modifica (RN-34). Inicios cada 15 minutos en horas de reloj locales donde cabe el servicio completo (RN-10), desde ahora + `minutosMinAnticipacion` (RN-06) y hasta hoy local + `diasMaxAnticipacion` (RN-07). Fechas locales en la `zonaHoraria` de la barbería. Sin `barberoId` (Cualquiera disponible): unión sin repetir de los barberos con membresía ACTIVO, cuenta activa y el servicio asignado (RN-23, D-33); no se asigna barbero.';

export const registrarReservas: RegistrarDocumentacion = (registro) => {
  // Dentro de la funcion: compartido/documentacion importa este modulo (ciclo de importacion).
  const ERROR_SESION = respuestaError(
    'AUTENTICACION_REQUERIDA o TOKEN_VENCIDO: sin token, token inválido o cuenta inactiva (D-05)',
  );
  const ERROR_NO_ENCONTRADO = respuestaError(
    'NO_ENCONTRADO: barbería inexistente, inactiva o no publicada (también para sus miembros, D7); servicio o barbero inexistente o de otra barbería, o barbero con la cuenta desactivada (SEG-02, D-33) o con membresía INVITADO',
  );
  const ERROR_INACTIVO = respuestaError(
    'RECURSO_INACTIVO: servicio inactivo, o barbero con membresía INACTIVO',
  );

  registro.registerPath({
    method: 'get',
    path: '/barberias/{id}/disponibilidad',
    tags: ['reservas'],
    summary: 'Horarios libres de una fecha (RES-04)',
    description: `Para cualquier usuario autenticado. ${ALGORITMO} \`horarios\` ascendentes en ISO 8601 UTC. Fecha pasada o fuera de \`diasMaxAnticipacion\`: lista vacía. Solo lee.`,
    security: SEGURIDAD_BEARER,
    request: { params: parametrosBarberia, query: esquemaConsultaDisponibilidad },
    responses: {
      200: {
        description: 'Inicios libres de la fecha',
        content: { 'application/json': { schema: esquemaRespuestaDisponibilidadDoc } },
      },
      401: ERROR_SESION,
      404: ERROR_NO_ENCONTRADO,
      409: ERROR_INACTIVO,
      422: respuestaError(
        'DATOS_INVALIDOS: falta `servicioId` o `fecha`, ids que no son UUID, fecha que no es AAAA-MM-DD o no existe, o parámetro desconocido. SERVICIO_NO_OFRECIDO: el barbero de la barbería no ofrece el servicio (RN-23)',
      ),
    },
  });

  registro.registerPath({
    method: 'get',
    path: '/barberias/{id}/disponibilidad/dias',
    tags: ['reservas'],
    summary: 'Días del calendario con horario libre (RES-03)',
    description: `Para cualquier usuario autenticado. Un elemento por día de \`desde\` a \`hasta\` (inclusive, máximo 31), en orden; \`disponible\` es verdadero si el día conserva al menos un inicio con el mismo cálculo de GET /disponibilidad (CU-07). ${ALGORITMO} Solo lee.`,
    security: SEGURIDAD_BEARER,
    request: { params: parametrosBarberia, query: esquemaConsultaDiasDisponibles },
    responses: {
      200: {
        description: 'Días del rango con su disponibilidad',
        content: { 'application/json': { schema: esquemaRespuestaDiasDisponiblesDoc } },
      },
      401: ERROR_SESION,
      404: ERROR_NO_ENCONTRADO,
      409: ERROR_INACTIVO,
      422: respuestaError(
        'DATOS_INVALIDOS: falta `servicioId`, `desde` o `hasta`, fechas mal formadas o inexistentes, `desde` posterior a `hasta`, más de 31 días o parámetro desconocido. SERVICIO_NO_OFRECIDO: el barbero de la barbería no ofrece el servicio (RN-23)',
      ),
    },
  });

  registro.registerPath({
    method: 'post',
    path: '/citas',
    tags: ['reservas'],
    summary: 'Crear una cita (RES-06)',
    description:
      'Para cualquier usuario autenticado, que queda como cliente (D-31). Sin `barberoId` = Cualquiera disponible: se asigna el barbero libre con menos citas activas ese día local, empate por menor id (CU-07 A3), y la respuesta trae su `barbero`. `iniciaEn` en ISO 8601 con cualquier desfase (se guarda en UTC) y en un bloque de 15 minutos (RN-10, D6). Transacción con bloqueo del barbero y del cliente, cancelación de sus PENDIENTE con anticipo vencido (RN-34) y restricción `ex_citas_barbero_sin_cruce` de respaldo (D-19). Copia precio y duración del servicio (RN-02, RN-03). Nace CONFIRMADA, o PENDIENTE con `anticipoVenceEn` = ahora + 15 min si la barbería exige anticipo (RN-12). Idempotencia (D2): la misma `claveIdempotencia` del mismo cliente responde 200 con la cita ya creada, sin revalidar. Orden de validación de §8.5.',
    security: SEGURIDAD_BEARER,
    request: {
      body: { content: { 'application/json': { schema: esquemaCrearCitaDoc } } },
    },
    responses: {
      200: {
        description: 'La claveIdempotencia ya se usó: la cita creada entonces (D2)',
        content: { 'application/json': { schema: esquemaRespuestaCitaDoc } },
      },
      201: {
        description: 'Cita creada',
        content: { 'application/json': { schema: esquemaRespuestaCitaDoc } },
      },
      401: ERROR_SESION,
      404: ERROR_NO_ENCONTRADO,
      409: respuestaError(
        'RECURSO_INACTIVO: servicio inactivo o barbero con membresía INACTIVO. BARBERO_NO_DISPONIBLE: bloqueo del barbero o cierre de la barbería en el intervalo (RN-26). HORARIO_OCUPADO: cruce con otra cita activa del barbero, o ningún candidato libre (RN-04, RN-11). CRUCE_DEL_CLIENTE: el cliente ya tiene una cita que se solapa (RN-08). LIMITE_DE_CITAS: alcanzó `maxCitasActivas` citas futuras activas en la barbería (RN-09)',
      ),
      422: respuestaError(
        'DATOS_INVALIDOS: campo extra o faltante, ids que no son UUID, `iniciaEn` sin hora o zona o fuera del bloque de 15 minutos (RN-10), notas de más de 200 caracteres. SERVICIO_NO_OFRECIDO (RN-23). HORARIO_PASADO, ANTICIPACION_INSUFICIENTE (RN-06), FECHA_DEMASIADO_LEJANA (RN-07). FUERA_DE_HORARIO: no cabe en el horario de la barbería y del barbero o toca una pausa (RN-05)',
      ),
    },
  });
};
