import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load-typescript.js';

describe('draggable overlay position', () => {
  const { clampOverlayPosition, normalizeOverlayPosition, DEFAULT_OVERLAY_POSITION } =
    loadTypeScript('src/content/position.ts');
  const bounds = {
    viewportWidth: 1280,
    viewportHeight: 800,
    width: 296,
    height: 200,
    tabWidth: 22,
  };

  it('keeps positions that already fit untouched', () => {
    assert.deepEqual(
      { ...clampOverlayPosition(DEFAULT_OVERLAY_POSITION, bounds) },
      { top: 86, right: 18 },
    );
  });

  it('clamps the card and its side tab inside the viewport', () => {
    assert.deepEqual(
      { ...clampOverlayPosition({ top: -50, right: -20 }, bounds) },
      {
        top: 8,
        right: 8,
      },
    );
    assert.deepEqual(
      { ...clampOverlayPosition({ top: 5000, right: 5000 }, bounds) },
      {
        top: 800 - 200 - 8,
        right: 1280 - 296 - 22 - 8,
      },
    );
  });

  it('pins to the top-right gap when the viewport is smaller than the card', () => {
    assert.deepEqual(
      {
        ...clampOverlayPosition(
          { top: 300, right: 300 },
          { ...bounds, viewportWidth: 200, viewportHeight: 100 },
        ),
      },
      { top: 8, right: 8 },
    );
  });

  it('rejects malformed stored positions', () => {
    assert.equal(normalizeOverlayPosition(null), null);
    assert.equal(normalizeOverlayPosition({ top: '1', right: 2 }), null);
    assert.equal(normalizeOverlayPosition({ top: Number.NaN, right: 2 }), null);
    assert.deepEqual(
      { ...normalizeOverlayPosition({ top: 120, right: 40 }) },
      {
        top: 120,
        right: 40,
      },
    );
  });
});
