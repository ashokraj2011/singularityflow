import { SingularityFlowError } from '../util.mjs';

const DAY = 86_400_000;
const dateText = instant => new Date(instant).toISOString().slice(0, 10);
const invalid = message => { throw new SingularityFlowError(message, { code: 'ASK_TIME_WINDOW_INVALID' }); };

function dateValue(text) {
  const instant = Date.parse(text + 'T00:00:00.000Z');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(text) || text.startsWith('0000') ||
      !Number.isFinite(instant) || dateText(instant) !== text) {
    invalid('Enter a valid calendar date in YYYY-MM-DD format.');
  }
  return instant;
}

function calendar(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit'
    });
  } catch {
    return invalid('Enter an IANA timezone such as Asia/Kolkata, America/New_York, or UTC.');
  }
}

function localDate(format, instant) {
  const { year, month, day } = Object.fromEntries(format.formatToParts(instant).map(({ type, value }) => [type, value]));
  return year.padStart(4, '0') + '-' + month + '-' + day;
}

function boundary(format, day) {
  const instant = dateValue(day);
  let lower = instant - 2 * DAY;
  let upper = instant + 2 * DAY;
  // Find the first instant of this local day independently of all other boundaries. Calendar
  // days can be shorter or longer than 24 hours, and in some zones a civil day was skipped.
  while (upper - lower > 1) {
    const candidate = Math.floor((lower + upper) / 2);
    if (localDate(format, candidate) >= day) upper = candidate;
    else lower = candidate;
  }
  return upper;
}

export function askTimeWindow({ startDate, endDate, timeZone = 'UTC', period, asOf = false }, anchor = new Date()) {
  if (!/^(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/iu.test(timeZone)) {
    invalid('Enter an IANA timezone such as Asia/Kolkata, America/New_York, or UTC.');
  }
  const format = calendar(timeZone);
  if (period) {
    const today = dateValue(localDate(format, anchor));
    if (period === 'last week') {
      const weekday = (new Date(today).getUTCDay() + 6) % 7;
      const monday = today - weekday * DAY;
      startDate = dateText(monday - 7 * DAY);
      endDate = dateText(monday - DAY);
    } else {
      startDate = endDate = dateText(today - (period === 'yesterday' ? DAY : 0));
    }
  }
  if (dateValue(startDate) > dateValue(endDate)) invalid('The first date must be on or before the last date.');
  const startInclusive = boundary(format, startDate);
  const endExclusive = boundary(format, dateText(dateValue(endDate) + DAY));
  if (localDate(format, startInclusive) !== startDate || localDate(format, boundary(format, endDate)) !== endDate) {
    invalid('One of the requested dates does not exist in this timezone. Choose an adjacent calendar date.');
  }
  return {
    startDate, endDate, timeZone, anchorInstant: period ? anchor.toISOString() : null, calendarConvention: 'iso8601-monday-start',
    startInclusive: asOf ? null : new Date(startInclusive).toISOString(), endExclusive: new Date(endExclusive).toISOString()
  };
}
