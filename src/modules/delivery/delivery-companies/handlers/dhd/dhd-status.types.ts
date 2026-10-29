export interface DhdActivityDto {
  date?: string | null;
  time?: string | null;
  status?: string | null;
  scanLocation?: string | null;
  scan_location?: string | null;
  station?: string | null;
  driver?: string | null;
  reason?: string | null;
  details?: string | null;
  postponed_to?: string | null;
  postponedTo?: string | null;
  [key: string]: unknown;
}

export interface DhdParcelDto {
  tracking?: string | null;
  reference?: string | null;
  order_id?: string | number | null;
  status?: string | null;
  desk_phone?: string | null;
  desk_commune?: string | null;
  desk_map_link?: string | null;
  desk_address?: string | null;
  driver_phone?: string | null;
  activity?: DhdActivityDto[] | null;
  recipientName?: string | null;
  shippedBy?: string | null;
  originCity?: string | number | null;
  destLocationCity?: string | number | null;
  [key: string]: unknown;
}

export interface DhdStatusResponseDto {
  data?: Record<string, DhdParcelDto> | DhdParcelDto[] | null;
  trackings?: DhdParcelDto[] | null;
  orders?: Record<string, DhdParcelDto> | null;
  success?: boolean | null;
  message?: string | null;
  [key: string]: unknown;
}

export interface DhdHistoryResponseDto {
  tracking?: string | null;
  activity?: DhdActivityDto[] | null;
  data?: DhdParcelDto | null;
  success?: boolean | null;
  message?: string | null;
  [key: string]: unknown;
}
