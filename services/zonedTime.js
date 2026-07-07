export function zonedDateKey(date = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function zonedTimeToDate(dateKey, { hour = 0, minute = 0, second = 0 } = {}, timeZone = 'America/Los_Angeles') {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  for (let index = 0; index < 3; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]));
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += desired - actual;
  }
  return new Date(guess);
}

export function nextDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
