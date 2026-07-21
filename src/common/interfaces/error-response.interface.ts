export interface ErrorResponse {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
  code?: string;
  params?: Record<string, unknown>;
  errors?: Record<string, string[]>;
}
