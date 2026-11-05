import { createAsyncStore, type Operation, type StoreOperations } from "../src/store.ts";

/** One short-lived store per operation; SSH calls never block Pi's event loop. */
export async function callStore<K extends Operation>(operation: K, ...args: StoreOperations[K]["args"]): Promise<StoreOperations[K]["result"]> {
  const store = createAsyncStore();
  try {
    return await store.call(operation, ...args);
  } finally {
    store.close();
  }
}

