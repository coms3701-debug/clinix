/**
 * Estados da máquina de conversação do chatbot
 */
export enum ConversationState {
  IDLE = 'IDLE',
  CHOOSING_SERVICE = 'CHOOSING_SERVICE',
  CHOOSING_PROFESSIONAL = 'CHOOSING_PROFESSIONAL',
  CHOOSING_DATE = 'CHOOSING_DATE',
  CHOOSING_TIME = 'CHOOSING_TIME',
  COLLECTING_INFO = 'COLLECTING_INFO',
  CONFIRMING = 'CONFIRMING',
  WAITING_RESCHEDULING = 'WAITING_RESCHEDULING',
  DONE = 'DONE',
}

export interface ConversationContext {
  serviceId?: string;
  serviceName?: string;
  professionalId?: string;
  professionalName?: string;
  selectedDate?: string; // ISO date "YYYY-MM-DD"
  selectedTime?: string; // "HH:MM"
  patientName?: string;
  patientCpf?: string;
  // Para remarcação
  appointmentId?: string;
  // Índice de paginação de datas disponíveis
  datePageIndex?: number;
}
