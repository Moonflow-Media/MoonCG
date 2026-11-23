import { errorMessage, type Logger } from './logger.js';

export type Dispose = () => void | Promise<void>;

export interface Lifecycle {
  /** Registers a started service. Services are disposed in reverse order of registration. */
  add(name: string, dispose: Dispose): void;
  /** Disposes everything registered so far. A failing service does not stop the others. */
  dispose(): Promise<void>;
}

export function createLifecycle(logger: Logger): Lifecycle {
  const services: { name: string; dispose: Dispose }[] = [];
  return {
    add(name, dispose) {
      services.push({ name, dispose });
    },
    async dispose() {
      for (let service = services.pop(); service; service = services.pop()) {
        try {
          await service.dispose();
        } catch (error) {
          logger.error(`Failed to dispose "${service.name}": ${errorMessage(error)}`);
        }
      }
    },
  };
}
