import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { featureFilter, createExpression, latest } from '@maplibre/maplibre-gl-style-spec';

const require = createRequire(import.meta.url);
const { guardNullNumbers } = require('../public/basemap-style.js');

// Shaped like OpenFreeMap Liberty's highway-shield / poi / building-3d layers.
function sampleStyle() {
  return {
    layers: [
      {
        id: 'highway-shield-non-us',
        filter: ['all', ['<=', ['get', 'ref_length'], 6], ['match', ['get', 'network'], ['us-highway'], false, true]],
      },
      { id: 'poi_r7', filter: ['all', ['>=', ['get', 'rank'], 7], ['<', ['get', 'rank'], 20]] },
      { id: 'reversed', filter: ['>', 3, ['get', 'rank']] },
      { id: 'literal', filter: ['in', ['get', 'class'], ['literal', ['<=', 'a', 'b']]] },
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        paint: { 'fill-extrusion-height': ['get', 'render_height'], 'fill-extrusion-base': ['get', 'render_min_height'] },
      },
    ],
  };
}

function feature(properties) {
  return { type: 2, properties, geometry: [] };
}

// Runs fn, returning whatever MapLibre logged via console.warn meanwhile.
function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

test('unpatched filters warn on a missing numeric property (reproduces the bug)', () => {
  const f = featureFilter(sampleStyle().layers[0].filter);
  const warnings = captureWarnings(() => f.filter({ zoom: 14 }, feature({ network: 'ca-transcanada' })));
  assert.match(warnings.join('\n'), /Expected value to be of type number, but found null instead/);
});

test('patched filters reject features missing the property, silently', () => {
  const layers = guardNullNumbers(sampleStyle()).layers.filter((l) => l.filter);
  const warnings = captureWarnings(() => {
    for (const layer of layers) {
      assert.equal(featureFilter(layer.filter).filter({ zoom: 14 }, feature({})), false, layer.id);
    }
  });
  assert.deepEqual(warnings, []);
});

test('patched filters still match features that have the property', () => {
  const [shield, poi, reversed] = guardNullNumbers(sampleStyle()).layers;
  const ev = (layer, props) => featureFilter(layer.filter).filter({ zoom: 14 }, feature(props));
  assert.equal(ev(shield, { ref_length: 3, network: 'ca-transcanada' }), true);
  assert.equal(ev(shield, { ref_length: 8, network: 'ca-transcanada' }), false);
  assert.equal(ev(poi, { rank: 10 }), true);
  assert.equal(ev(poi, { rank: 25 }), false);
  assert.equal(ev(reversed, { rank: 1 }), true);
  assert.equal(ev(reversed, { rank: 5 }), false);
});

test('literal arrays are left untouched', () => {
  const layer = guardNullNumbers(sampleStyle()).layers[3];
  assert.deepEqual(layer.filter, ['in', ['get', 'class'], ['literal', ['<=', 'a', 'b']]]);
});

test('fill-extrusion heights fall back to 0 instead of warning', () => {
  const { paint } = guardNullNumbers(sampleStyle()).layers[4];
  const height = createExpression(paint['fill-extrusion-height'], latest['paint_fill-extrusion']['fill-extrusion-height']);
  assert.equal(height.result, 'success');
  const warnings = captureWarnings(() => {
    assert.equal(height.value.evaluate({ zoom: 16 }, feature({})), 0);
    assert.equal(height.value.evaluate({ zoom: 16 }, feature({ render_height: 12 })), 12);
  });
  assert.deepEqual(warnings, []);
});
