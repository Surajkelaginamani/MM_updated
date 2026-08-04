const IST_TIME_ZONE = 'Asia/Kolkata';

const getISTDateParts = (referenceDate = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(referenceDate));

  return Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value])
  );
};

const normalizeDateKey = (referenceDate = new Date()) => {
  const { year, month, day } = getISTDateParts(referenceDate);
  return `${year}-${month}-${day}`;
};

const getTodayMenuDateInfo = (referenceDate = new Date()) => {
  const dateKey = normalizeDateKey(referenceDate);
  // IST midnight is 18:30 UTC on the preceding calendar day.
  const start = new Date(`${dateKey}T00:00:00.000+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { dateKey, start, end };
};

const buildTodayMenuQuery = (vendorId, referenceDate = new Date()) => ({
  vendor: vendorId,
  dateKey: normalizeDateKey(referenceDate),
});

module.exports = {
  IST_TIME_ZONE,
  normalizeDateKey,
  getTodayMenuDateInfo,
  buildTodayMenuQuery,
};
