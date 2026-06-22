import fs from 'fs/promises';
import path from 'path';
import { readCsvFile, parseCsv } from './csv.js';

const dataRoot = process.env.LOCAL_DATA_DIR || './data';
const REQUIRED_CSVS = ['schedule.csv', 'teams.csv', 'players.csv'];
const DATA_CACHE_MS = Number(process.env.DATA_CACHE_MS || 60000);
const csvTextCache = new Map();

function dataMode() {
  return String(process.env.DATA_MODE || 'local').trim().toLowerCase();
}

function githubBaseUrl() {
  return String(process.env.WCPL_DATA_BASE_URL || '').trim().replace(/\/+$/, '');
}

function seasonRoot(seasonId = process.env.SEASON_ID || 'S3') {
  return path.join(dataRoot, seasonId);
}

function githubUrl(parts) {
  const base = githubBaseUrl();
  if (!base) throw new Error('WCPL_DATA_BASE_URL is required when DATA_MODE=github.');
  return `${base}/${parts.map(p => encodeURIComponent(String(p))).join('/')}`;
}

async function existsLocal(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readGithubText(parts) {
  const url = githubUrl(parts);
  const now = Date.now();
  const cached = csvTextCache.get(url);
  if (cached && now - cached.ts < DATA_CACHE_MS) return cached.text;

  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to read WCPL data from GitHub: ${res.status} ${url}`);

  const text = await res.text();
  csvTextCache.set(url, { ts: now, text });
  return text;
}

async function existsSource(parts) {
  if (dataMode() === 'github') return (await readGithubText(parts)) !== null;
  return existsLocal(path.join(dataRoot, ...parts));
}

async function readCsvSource(parts) {
  if (dataMode() === 'github') {
    const text = await readGithubText(parts);
    return text == null ? [] : parseCsv(text);
  }

  const filePath = path.join(dataRoot, ...parts);
  if (!(await existsLocal(filePath))) return [];
  return readCsvFile(filePath);
}

export async function getSeasonCsv(seasonId, fileName, divisionId = 'ALL') {
  const parts = divisionId && divisionId !== 'ALL'
    ? [seasonId, divisionId, fileName]
    : [seasonId, fileName];
  return readCsvSource(parts);
}

export function clearWcplDataCache() {
  csvTextCache.clear();
}

export async function getAvailableSeasons() {
  if (dataMode() === 'github') {
    const configured = String(process.env.AVAILABLE_SEASONS || 'S2,S3')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return [...new Set(configured)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  try {
    const entries = await fs.readdir(dataRoot, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function bettingExcludedDivisionIds() {
  return new Set(
    String(process.env.BETTING_EXCLUDED_DIVISIONS ?? 'D3')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

export function isBettingDivision(divisionId) {
  return !bettingExcludedDivisionIds().has(String(divisionId || '').trim().toUpperCase());
}

export async function getBettingDivisions(seasonId = process.env.SEASON_ID || 'S3') {
  return (await getDivisions(seasonId)).filter(d => isBettingDivision(d.division_id));
}

export async function getDivisions(seasonId = process.env.SEASON_ID || 'S3') {
  const season = String(seasonId || '').trim();

  // New S3 style: data/S3/divisions.csv + data/S3/D1/*.csv, data/S3/D2/*.csv
  const divisions = await readCsvSource([season, 'divisions.csv']);
  if (divisions.length) {
    return divisions.map(d => ({
      division_id: String(d.division_id || '').trim(),
      division_name: String(d.division_name || d.division_id || '').trim(),
      source_parts: [season, String(d.division_id || '').trim()]
    })).filter(d => d.division_id);
  }

  // Old/S2 style: data/S2/*.csv directly in the season folder.
  const hasDirectCsvs = (await Promise.all(REQUIRED_CSVS.map(f => existsSource([season, f])))).every(Boolean);
  if (hasDirectCsvs) {
    return [{
      division_id: 'ALL',
      division_name: 'League',
      source_parts: [season]
    }];
  }

  // For GitHub raw URLs, folder listing is not available. Use DIVISIONS if provided.
  if (dataMode() === 'github') {
    const configuredDivisions = String(process.env.DIVISIONS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const out = [];
    for (const divId of configuredDivisions) {
      const hasCsvs = (await Promise.all(REQUIRED_CSVS.map(f => existsSource([season, divId, f])))).every(Boolean);
      if (!hasCsvs) continue;
      out.push({ division_id: divId, division_name: divId, source_parts: [season, divId] });
    }
    return out;
  }

  // Local folder-discovery style: every child folder with schedule/teams/players is a division.
  try {
    const root = seasonRoot(season);
    const entries = await fs.readdir(root, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const divId = entry.name;
      const hasCsvs = (await Promise.all(REQUIRED_CSVS.map(f => existsSource([season, divId, f])))).every(Boolean);
      if (!hasCsvs) continue;
      out.push({
        division_id: divId,
        division_name: divId,
        source_parts: [season, divId]
      });
    }
    return out.sort((a, b) => a.division_id.localeCompare(b.division_id, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function getDivision(seasonId, divisionId) {
  const divisions = await getDivisions(seasonId);
  const division = divisions.find(d => d.division_id === divisionId);
  if (!division) throw new Error(`Division not found: ${divisionId}`);
  return division;
}

async function readDivisionCsv(division, fileName) {
  return readCsvSource([...division.source_parts, fileName]);
}

export async function getTeams(divisionId, seasonId = process.env.SEASON_ID || 'S3') {
  const division = await getDivision(seasonId, divisionId);
  return readDivisionCsv(division, 'teams.csv');
}

export async function getSchedule(divisionId, seasonId = process.env.SEASON_ID || 'S3') {
  const division = await getDivision(seasonId, divisionId);
  return readDivisionCsv(division, 'schedule.csv');
}

export async function getGames(divisionId, seasonId = process.env.SEASON_ID || 'S3') {
  const division = await getDivision(seasonId, divisionId);
  return readDivisionCsv(division, 'games.csv');
}

export async function getBoxscores(divisionId, seasonId = process.env.SEASON_ID || 'S3') {
  const division = await getDivision(seasonId, divisionId);
  return readDivisionCsv(division, 'boxscores.csv');
}

export async function getUpcomingSeries(week = Number(process.env.CURRENT_WEEK || 1), seasonId = process.env.SEASON_ID || 'S3') {
  const divisions = await getBettingDivisions(seasonId);
  const all = [];

  for (const div of divisions) {
    const divisionId = div.division_id;
    const [teams, schedule] = await Promise.all([
      getTeams(divisionId, seasonId),
      getSchedule(divisionId, seasonId)
    ]);

    const teamMap = new Map(teams.map(t => [t.team_id, t]));
    const weekRows = schedule.filter(r => Number(r.week) === Number(week) && String(r.stage || '').toLowerCase() === 'reg');
    const grouped = new Map();

    for (const row of weekRows) {
      const seriesId = String(row.match_id || '').replace(/-G\d+$/, '');
      if (!grouped.has(seriesId)) grouped.set(seriesId, []);
      grouped.get(seriesId).push(row);
    }

    for (const [seriesId, games] of grouped.entries()) {
      games.sort((a, b) => String(a.match_id).localeCompare(String(b.match_id), undefined, { numeric: true }));
      const first = games[0];
      const homeTeam = teamMap.get(first.home_team_id) || { team_id: first.home_team_id, team_name: first.home_team_id };
      const awayTeam = teamMap.get(first.away_team_id) || { team_id: first.away_team_id, team_name: first.away_team_id };
      all.push({
        series_key: `${divisionId}-${seriesId}`,
        season_id: seasonId,
        division_id: divisionId,
        division_name: div.division_name,
        series_id: seriesId,
        week: Number(first.week),
        home_team_id: first.home_team_id,
        away_team_id: first.away_team_id,
        home_team_name: homeTeam.team_name,
        away_team_name: awayTeam.team_name,
        games
      });
    }
  }

  return all.sort((a, b) => a.division_id.localeCompare(b.division_id) || a.series_id.localeCompare(b.series_id, undefined, { numeric: true }));
}

export async function getPlayers(divisionId, seasonId = process.env.SEASON_ID || 'S3') {
  const division = await getDivision(seasonId, divisionId);
  const rows = await readDivisionCsv(division, 'players.csv');
  return rows
    .filter(p => String(p.name || '').trim())
    .map(p => ({
      ...p,
      division_id: divisionId,
      display_name: String(p.name || '').trim(),
      player_key: String(p.player_key || p.steam_id || p.name || '').trim(),
      steam_id: String(p.steam_id || '').trim(),
      team_id: String(p.team_id || '').trim(),
      position: String(p.position || '').trim().toUpperCase()
    }));
}

export async function getPropBoards(week = Number(process.env.CURRENT_WEEK || 1), seasonId = process.env.SEASON_ID || 'S3', odds = {}) {
  const divisions = await getBettingDivisions(seasonId);
  const weekSeries = await getUpcomingSeries(week, seasonId);
  const eligibleTeamsByDivision = new Map();

  for (const s of weekSeries) {
    if (!eligibleTeamsByDivision.has(s.division_id)) eligibleTeamsByDivision.set(s.division_id, new Set());
    const teams = eligibleTeamsByDivision.get(s.division_id);
    teams.add(String(s.home_team_id || '').trim());
    teams.add(String(s.away_team_id || '').trim());
  }

  const boards = [];

  for (const div of divisions) {
    const divisionId = div.division_id;
    const eligibleTeams = eligibleTeamsByDivision.get(divisionId) || new Set();
    const players = (await getPlayers(divisionId, seasonId))
      .filter(p => eligibleTeams.has(String(p.team_id || '').trim()));
    const isSkaterPosition = (position) => {
      const p = String(position || '').toUpperCase();
      return p.includes('S') || (!p.includes('G'));
    };
    const isGoaliePosition = (position) => {
      const p = String(position || '').toUpperCase();
      return p.includes('G');
    };

    const skaters = players
      .filter(p => isSkaterPosition(p.position))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    const goalies = players
      .filter(p => isGoaliePosition(p.position))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));

    boards.push({
      division_id: divisionId,
      division_name: div.division_name,
      week: Number(week),
      eligible_team_ids: [...eligibleTeams],
      skaters,
      goalies,
      categories: buildPropCategories({ divisionId, divisionName: div.division_name, week, skaters, goalies, odds })
    });
  }

  return boards;
}

export function buildPropCategories({ divisionId, divisionName, week, skaters, goalies, odds = {} }) {
  const propDefaults = odds.propDefaults || {};
  const propPlayerOverrides = odds.propPlayerOverrides || {};

  const defaultFor = (category, fallback, quantity = null) => {
    const key = quantity == null ? `${divisionId}|${category}` : `${divisionId}|${category}|${quantity}`;
    return Number(propDefaults[key] ?? fallback);
  };

  const withPlayerOdds = (players, category, fallback) => players.map(p => {
    const key = `${divisionId}|${category}|${p.player_key}`;
    const mult = Number(propPlayerOverrides[key] ?? defaultFor(category, fallback));
    return { ...p, prop_multiplier: mult };
  });

  const withQuantityPlayerOdds = (players, category, fallbackByQuantity) => players.map(p => {
    const quantityMultipliers = {};
    for (const q of [1, 2, 3]) {
      const key = `${divisionId}|${category}|${p.player_key}|${q}`;
      quantityMultipliers[q] = Number(propPlayerOverrides[key] ?? defaultFor(category, fallbackByQuantity[q], q));
    }
    return { ...p, prop_quantity_multipliers: quantityMultipliers };
  });

  const topScorerPlayers = withPlayerOdds(skaters, 'top_scorer', 5);
  const topGoaliePlayers = withPlayerOdds(goalies, 'top_goalie', 5);
  const hatTrickPlayers = withQuantityPlayerOdds(skaters, 'hat_trick', { 1: 2, 2: 8, 3: 25 });
  const shutoutPlayers = withQuantityPlayerOdds(goalies, 'shutout', { 1: 2, 2: 8, 3: 25 });

  return [
    {
      prop_key: `${divisionId}|top_scorer`,
      category: 'top_scorer',
      title: 'Top Scorer',
      description: 'Most points in the division this week. (avg. per series)',
      player_pool: 'skaters',
      players: topScorerPlayers,
      quantity_options: [],
      multiplier: defaultFor('top_scorer', 5)
    },
    {
      prop_key: `${divisionId}|top_goalie`,
      category: 'top_goalie',
      title: 'Top Goalie',
      description: 'Best SV% in the division this week. Minimum 15 shots against.',
      player_pool: 'goalies',
      players: topGoaliePlayers,
      quantity_options: [],
      multiplier: defaultFor('top_goalie', 5)
    },
    {
      prop_key: `${divisionId}|hat_trick`,
      category: 'hat_trick',
      title: 'Hat Trick',
      description: 'Pick a skater to record 3+ goals in one game.',
      player_pool: 'skaters',
      players: hatTrickPlayers,
      quantity_options: [
        { quantity: 1, label: '1 Hat Trick', multiplier: defaultFor('hat_trick', 2, 1) },
        { quantity: 2, label: '2 Hat Tricks', multiplier: defaultFor('hat_trick', 8, 2) },
        { quantity: 3, label: '3 Hat Tricks', multiplier: defaultFor('hat_trick', 25, 3) }
      ],
      multiplier: defaultFor('hat_trick', 2, 1)
    },
    {
      prop_key: `${divisionId}|shutout`,
      category: 'shutout',
      title: 'Shutout',
      description: 'Pick a goalie to record a shutout.',
      player_pool: 'goalies',
      players: shutoutPlayers,
      quantity_options: [
        { quantity: 1, label: '1 Shutout', multiplier: defaultFor('shutout', 2, 1) },
        { quantity: 2, label: '2 Shutouts', multiplier: defaultFor('shutout', 8, 2) },
        { quantity: 3, label: '3 Shutouts', multiplier: defaultFor('shutout', 25, 3) }
      ],
      multiplier: defaultFor('shutout', 2, 1)
    }
  ];
}

export function buildMarketsForSeries(series, odds = {}) {
  const seriesOdds = odds.series || {};
  const teams = [
    { id: series.home_team_id, name: series.home_team_name },
    { id: series.away_team_id, name: series.away_team_name }
  ];

  const markets = [];
  const addMarket = (team, type, suffix, label, fallback) => {
    const market_key = `${series.series_key}|${suffix}|${team.id}`;
    markets.push({
      market_key,
      type,
      team_id: team.id,
      label,
      multiplier: Number(seriesOdds[market_key] ?? fallback)
    });
  };

  for (const team of teams) {
    addMarket(team, 'series_win', 'series_win', `${team.name} wins series`, 2);
    addMarket(team, 'exact_2_1', 'exact_2_1', `${team.name} wins 2-1`, 3);
    addMarket(team, 'sweep_3_0', 'sweep_3_0', `${team.name} sweeps 3-0`, 4);
  }
  return markets;
}

export function getGoalTotalForSeries(series, odds = {}) {
  const custom = (odds.goalTotals || {})[series.series_key] || {};
  return {
    line: Number(custom.line ?? process.env.GOAL_TOTAL_LINE ?? 10.5),
    boost: Number(custom.boost ?? process.env.GOAL_TOTAL_BOOST ?? 1.5)
  };
}
