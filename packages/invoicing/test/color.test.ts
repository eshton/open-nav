import { describe, expect, it } from 'vitest';
import { toHexColor, toMargins, toPoints } from '../src/color.js';

/**
 * The PDF engine understands hex and CSS colour keywords, while a browser
 * understands every CSS form. Converting here is what keeps a theme looking
 * the same whichever engine renders it.
 */
describe('toHexColor', () => {
  it('passes six-digit hex through and expands the short form', () => {
    expect(toHexColor('#0f4c81')).toBe('#0f4c81');
    expect(toHexColor('#ABC')).toBe('#aabbcc');
  });

  it('drops alpha, which has nowhere to go in a PDF fill', () => {
    expect(toHexColor('#0f4c8180')).toBe('#0f4c81');
    expect(toHexColor('rgba(15, 76, 129, 0.5)')).toBe('#0f4c81');
  });

  it('converts rgb, including percentages', () => {
    expect(toHexColor('rgb(15, 76, 129)')).toBe('#0f4c81');
    expect(toHexColor('rgb(100%, 0%, 0%)')).toBe('#ff0000');
    expect(toHexColor('rgb(15 76 129)')).toBe('#0f4c81');
  });

  it('converts hsl', () => {
    expect(toHexColor('hsl(0, 100%, 50%)')).toBe('#ff0000');
    expect(toHexColor('hsl(120 100% 25%)')).toBe('#008000');
    expect(toHexColor('hsl(0, 0%, 100%)')).toBe('#ffffff');
    expect(toHexColor('hsl(0, 0%, 0%)')).toBe('#000000');
  });

  it('knows the colour keywords a document is plausibly styled with', () => {
    expect(toHexColor('white')).toBe('#ffffff');
    expect(toHexColor('REBECCAPURPLE')).toBe('#663399');
  });

  it('falls back rather than emitting something a PDF cannot parse', () => {
    expect(toHexColor('lab(50% 40 59)', '#123456')).toBe('#123456');
    expect(toHexColor('not-a-colour', '#123456')).toBe('#123456');
  });
});

describe('toPoints', () => {
  it('converts the print units', () => {
    expect(toPoints('72pt', 0)).toBe(72);
    expect(toPoints('1in', 0)).toBe(72);
    expect(toPoints('25.4mm', 0)).toBeCloseTo(72, 4);
    expect(toPoints('2.54cm', 0)).toBeCloseTo(72, 4);
    expect(toPoints('96px', 0)).toBe(72);
  });

  it('treats a bare number as points', () => {
    expect(toPoints('12', 0)).toBe(12);
  });

  it('falls back for units that need a layout to resolve', () => {
    expect(toPoints('2em', 10)).toBe(10);
    expect(toPoints('50%', 10)).toBe(10);
    expect(toPoints('nonsense', 10)).toBe(10);
  });
});

describe('toMargins', () => {
  it('reorders the CSS shorthand into PDF order', () => {
    // CSS is clockwise from the top; pdfmake starts at the left. Getting this
    // wrong swaps the margins on a page that is not square.
    const [left, top, right, bottom] = toMargins('10pt 20pt', 0);
    expect({ left, top, right, bottom }).toEqual({ left: 20, top: 10, right: 20, bottom: 10 });
  });

  it('handles one, three and four values', () => {
    expect(toMargins('10pt', 0)).toEqual([10, 10, 10, 10]);
    expect(toMargins('10pt 20pt 30pt', 0)).toEqual([20, 10, 20, 30]);
    expect(toMargins('10pt 20pt 30pt 40pt', 0)).toEqual([40, 10, 20, 30]);
  });

  it('converts millimetres, as a page margin is usually given', () => {
    const [left, top] = toMargins('14mm 13mm', 0);
    expect(top).toBeCloseTo(39.685, 2);
    expect(left).toBeCloseTo(36.85, 2);
  });
});
