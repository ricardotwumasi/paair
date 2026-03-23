type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

function emit(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalLevel]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...(data ? { data } : {}),
  };

  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export function createLogger(component: string): Logger {
  return {
    debug: (message, data) => emit('debug', component, message, data),
    info: (message, data) => emit('info', component, message, data),
    warn: (message, data) => emit('warn', component, message, data),
    error: (message, data) => emit('error', component, message, data),
  };
}
