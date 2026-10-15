import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

// O servidor roda em UTC; o "dia" que importa é o do fuso da clínica.
// Usar startOfDay/new Date('YYYY-MM-DD') direto erra a partir das 21h (BRT).

/** "YYYY-MM-DD" do dia local (no fuso `tz`) do instante `ref`. */
export function localYMD(ref: Date, tz: string): string {
  return formatInTimeZone(ref, tz, 'yyyy-MM-dd');
}

/** Início e fim (como instantes UTC) do dia local "YYYY-MM-DD" no fuso `tz`. */
export function localDayBounds(ymd: string, tz: string): { start: Date; end: Date } {
  return {
    start: fromZonedTime(`${ymd}T00:00:00`, tz),
    end: fromZonedTime(`${ymd}T23:59:59.999`, tz),
  };
}
