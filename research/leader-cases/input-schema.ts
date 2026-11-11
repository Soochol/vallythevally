import { fields, list, text, number, day } from "./source-utils.ts";

export type Parser<T> = (input: unknown) => T;
export type Parsed<P> = P extends Parser<infer T> ? T : never;
export const string = text;
export const finite = number;
export const date = day;
export function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") throw new Error("expected_boolean");
  return input;
}
export function literal<const T extends string | number | boolean | null>(expected: T): Parser<T> {
  return (input) => { if (input !== expected) throw new Error(`expected_${expected}`); return expected; };
}
export function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (input) => input === null ? null : parse(input);
}
export function array<T>(parse: Parser<T>): Parser<T[]> {
  return (input) => list(input).map(parse);
}
export function object<const S extends Record<string, Parser<unknown>>>(shape: S): Parser<{ [K in keyof S]: Parsed<S[K]> }> {
  return (input) => {
    const source = fields(input);
    const entries = Object.entries(shape).map(([key, parse]) => {
      try { return [key, parse(source[key])]; }
      catch (error) { throw new Error(`${key}: ${error instanceof Error ? error.message : "invalid"}`); }
    });
    return Object.fromEntries(entries) as { [K in keyof S]: Parsed<S[K]> };
  };
}
export function union<A, B>(a: Parser<A>, b: Parser<B>): Parser<A | B> {
  return (input) => { try { return a(input); } catch { return b(input); } };
}
export function choice<const T extends readonly (string | number)[]>(values: T): Parser<T[number]> {
  return (input) => {
    const match = values.find((value) => value === input);
    if (match === undefined) throw new Error("unexpected_variant");
    return match;
  };
}
export function record<T>(parse: Parser<T>): Parser<Record<string, T>> {
  return (input) => Object.fromEntries(Object.entries(fields(input)).map(([key, value]) => [key, parse(value)]));
}
export function link(input: unknown): string {
  const value = text(input);
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\u0000-\u0020]/.test(value)) throw new Error("invalid_public_link");
  return url.href;
}
export function code(input: unknown): string {
  const value = text(input);
  if (!/^[0-9A-Z]{6}$/.test(value)) throw new Error("invalid_stock_code");
  return value;
}
export function ordered<T>(items: T[], dateOf: (item: T) => string): T[] {
  for (let i = 1; i < items.length; i++) if (dateOf(items[i - 1]!) >= dateOf(items[i]!)) throw new Error("dates_must_be_unique_and_ascending");
  return items;
}
