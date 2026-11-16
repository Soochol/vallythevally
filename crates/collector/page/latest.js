export const STALE = Symbol("stale");

export function latestOnly(load) {
  let current = 0;
  return async (...args) => {
    const request = ++current;
    let value;
    try {
      value = await load(...args);
    } catch (error) {
      if (request === current) throw error;
      return STALE;
    }
    return request === current ? value : STALE;
  };
}
