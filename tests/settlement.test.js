import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBetAgainstResults } from '../services/settlement.js';

test('series shutout props never borrow shutouts from another series', () => {
  const bet = {
    bet_kind: 'prop',
    division_id: 'D2',
    series_key: 'D2-M2',
    prop_category: 'shutout',
    player_key: 'name:ttearr',
    player_name: 'ttearr',
    quantity: 1
  };
  const weekResults = {
    seriesResults: {
      'D2-M2': { complete: true }
    },
    propResults: {
      D2: {
        shutout: {
          best_series_counts: { 'name:ttearr': 2 },
          series_counts: {
            'name:ttearr': [{ series_id: 'M5', count: 2 }]
          }
        }
      }
    }
  };

  const evaluation = evaluateBetAgainstResults(bet, weekResults);
  assert.equal(evaluation.ready, true);
  assert.equal(evaluation.won, false);
  assert.match(evaluation.result_summary, /0 shutout\(s\) in series M2/);
});
