/* DOM helpers.
 *
 * esc() matters: owner, used_for, notes and justification all originate in
 * issue forms, so they are user-written text. Interpolating them into innerHTML
 * without escaping would let a justification containing markup execute in every
 * viewer's browser. Escape EVERY interpolated value, including ones that look
 * like they came from us — the file is in our repo, but the words are not. */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** Escaping tagged template: html`<p>${userText}</p>` escapes every value. */
export function html(strings, ...values) {
  return strings.reduce((out, str, i) =>
    out + str + (i < values.length ? esc(values[i]) : ""), "");
}

/** Only for URLs we render as href — blocks javascript: and data: schemes. */
export function safeUrl(url) {
  const value = String(url || "").trim();
  return /^https?:\/\//i.test(value) ? esc(value) : "#";
}

export const $ = sel => document.querySelector(sel);
export const $$ = sel => Array.from(document.querySelectorAll(sel));
