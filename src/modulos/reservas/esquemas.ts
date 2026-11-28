// Esquemas de reservas: T3.2 (disponibilidad, RES-03, RES-04) y T3.3 (POST /citas, RES-06).
// La validacion vive en el contrato comun (la app usa los mismos).
import {
  esquemaCrearCita,
  esquemaRespuestaCita,
  esquemaRespuestaDiasDisponibles,
  esquemaRespuestaDisponibilidad,
} from '../../compartido/contrato';

export {
  esquemaConsultaDiasDisponibles,
  esquemaConsultaDisponibilidad,
  esquemaCrearCita,
} from '../../compartido/contrato';
export type {
  Cita,
  ConsultaDiasDisponibles,
  ConsultaDisponibilidad,
  DiaDisponible,
  Disponibilidad,
  EntradaCrearCita,
  HorarioDisponible,
  RespuestaCita,
  RespuestaDiasDisponibles,
  RespuestaDisponibilidad,
} from '../../compartido/contrato';

// Solo para la documentacion OpenAPI.
export const esquemaRespuestaDisponibilidadDoc = esquemaRespuestaDisponibilidad.meta({
  id: 'RespuestaDisponibilidad',
});
export const esquemaRespuestaDiasDisponiblesDoc = esquemaRespuestaDiasDisponibles.meta({
  id: 'RespuestaDiasDisponibles',
});
export const esquemaCrearCitaDoc = esquemaCrearCita.meta({ id: 'EntradaCrearCita' });
export const esquemaRespuestaCitaDoc = esquemaRespuestaCita.meta({ id: 'RespuestaCita' });
