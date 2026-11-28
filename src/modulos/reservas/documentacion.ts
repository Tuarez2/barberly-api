// Rutas de reservas para OpenAPI (§10.7). T3.2: disponibilidad (RES-03, RES-04).
import { z } from 'zod';

import type { RegistrarDocumentacion } from '../../compartido/documentacion';
import { respuestaError, SEGURIDAD_BEARER } from '../../compartido/documentacion';
import {
  esquemaConsultaDiasDisponibles,
  esquemaConsultaDisponibilidad,
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
};
