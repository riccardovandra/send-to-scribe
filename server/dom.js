import { DOMParser } from "linkedom";

/**
 * linkedom leaves <body> empty when given an HTML fragment (Substack post bodies, Readability output)
 * instead of a whole page, so wrap fragments in a full document first.
 */
export class FragmentSafeDOMParser extends DOMParser {
  parseFromString(markup, type) {
    if (type === "text/html" && !/<html[\s>]/i.test(markup)) {
      markup = `<!doctype html><html><head></head><body>${markup}</body></html>`;
    }
    return super.parseFromString(markup, type);
  }
}
