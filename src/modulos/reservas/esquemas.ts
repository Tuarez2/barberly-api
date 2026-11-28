// Esquemas de reservas (T3.2: disponibilidad, RES-03, RES-04). La validacion vive en el contrato comun.
import {
  esquemaRespuestaDiasDisponibles,
  esquemaRespuestaDisponibilidad,
} from '../../compartido/contrato';

export {
  esquemaConsultaDiasDisponibles,
  esquemaConsultaDisponibilidad,
} from '../../compartido/contrato';
export type {
  ConsultaDiasDisponibles,
  ConsultaDisponibilidad,
  DiaDisponible,
  Disponibilidad,
  HorarioDisponible,
  RespuestaDiasDisponibles,
  RespuestaDisponibilidad,
} from '../../compartido/contrato';

// Solo para la documentacion OpenAPI (RES-03, RES-04).
export const esquemaRespuestaDisponibilidadDoc = esquemaRespuestaDisponibilidad.meta({
  id: 'RespuestaDisponibilidad',
});
export const esquemaRespuestaDiasDisponiblesDoc = esquemaRespuestaDiasDisponibles.meta({
  id: 'RespuestaDiasDisponibles',
});
