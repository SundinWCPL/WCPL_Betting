import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSettlementPreview } from '../db.js';
import { evaluateBetAgainstResults } from '../services/settlement.js';
import { shouldVoidBetForSeries } from '../services/seriesVoidRules.js';

test('settlement preview can evaluate PostgreSQL-loaded bets instead of JSON state', () => {
  const bets = [{
    id: 524,
    user_id: 1,
    user_display_name: 'Sundin',
    week: 4,
    status: 'open',
    stake: 100,
    multiplier: 5,
    label: 'Division 2 Top Goalie: Sundin'
  }];
  const preview = buildSettlementPreview({
    week: 4,
    weekResults: {},
    bets,
    evaluator: () => ({ ready: false, won: false, reason: 'Week incomplete' })
  });

  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].id, 524);
  assert.equal(preview.rows[0].user_display_name, 'Sundin');
  assert.equal(preview.skipped, 1);
  assert.equal(preview.ready, false);
});

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

test('series void keeps weekly leader props eligible when player has other series', () => {
  const voidedSeries = {
    seriesKey: 'D2-M1',
    teamIds: ['TTE'],
    playerKeys: ['name:ttearr'],
    weeklyLeaderPlayerKeysWithOtherSeries: ['name:ttearr']
  };

  assert.equal(shouldVoidBetForSeries({
    bet_kind: 'prop',
    division_id: 'D2',
    series_key: '',
    prop_key: 'D2|top_goalie',
    prop_category: 'top_goalie',
    player_key: 'name:ttearr',
    player_team_id: 'TTE'
  }, voidedSeries), false);

  assert.equal(shouldVoidBetForSeries({
    bet_kind: 'prop',
    division_id: 'D2',
    series_key: '',
    prop_key: 'D2|top_goalie',
    prop_category: 'top_goalie',
    player_key: 'name:only-series-goalie',
    player_team_id: 'TTE'
  }, {
    ...voidedSeries,
    weeklyLeaderPlayerKeysWithOtherSeries: []
  }), true);

  assert.equal(shouldVoidBetForSeries({
    bet_kind: 'prop',
    division_id: 'D2',
    series_key: 'D2-M1',
    prop_key: 'D2-M1|shutout|name:ttearr',
    prop_category: 'shutout',
    player_key: 'name:ttearr',
    player_team_id: 'TTE'
  }, voidedSeries), true);
});
