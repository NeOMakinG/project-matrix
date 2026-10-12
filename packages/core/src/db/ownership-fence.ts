export function fenceDatabase<T extends object>(database: T, assertOwned: () => void): T {
  const cache = new WeakMap<object, object>();
  const wrap = (target: object): object => {
    const prior = cache.get(target);
    if (prior) return prior;
    const proxy = new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key);
        if (typeof value !== "function") return value;
        if (key === "then")
          return (
            fulfilled?: (result: unknown) => unknown,
            rejected?: (error: unknown) => unknown,
          ) =>
            Promise.resolve()
              .then(() => {
                assertOwned();
                return new Promise((resolve, reject) =>
                  Reflect.apply(value, object, [resolve, reject]),
                );
              })
              .then((result) => {
                assertOwned();
                return result;
              })
              .then(fulfilled, rejected);
        if (key === "transaction")
          return async (
            callback: (transaction: object) => Promise<unknown>,
            ...args: unknown[]
          ) => {
            assertOwned();
            const result = await Reflect.apply(value, object, [
              async (transaction: object) => {
                assertOwned();
                const outcome = await callback(wrap(transaction));
                assertOwned();
                return outcome;
              },
              ...args,
            ]);
            assertOwned();
            return result;
          };
        return (...args: unknown[]) => {
          assertOwned();
          const result: unknown = Reflect.apply(value, object, args);
          return typeof result === "object" && result !== null ? wrap(result) : result;
        };
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(database) as T;
}
