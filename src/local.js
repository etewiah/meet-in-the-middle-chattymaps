// Finds the middle and the places on this machine (Apple Maps), producing the
// same summary shape as ChattyMaps' /api/middle. Only the midpoint and the
// chosen places are ever sent to ChattyMaps, never the starting places.

const EARTH_RADIUS_M = 6_371_000;
const MAX_RADIUS_M = 5000;
const COORDINATES = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export class LocalSearchError extends Error {
  constructor(message, data = null) {
    super(message);
    this.data = data;
  }
}

export function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function midpointOf(points) {
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: Number((sum.lat / points.length).toFixed(6)), lng: Number((sum.lng / points.length).toFixed(6)) };
}

function spread(points) {
  let max = 0;
  for (let i = 0; i < points.length; i += 1)
    for (let j = i + 1; j < points.length; j += 1) max = Math.max(max, distanceMeters(points[i], points[j]));
  return Math.round(max);
}

export function radiusSteps(startM) {
  return [...new Set([startM, startM * 2, startM * 4].map((r) => Math.min(MAX_RADIUS_M, r)))];
}

/** Inside the circle, nearest the middle first, one per name and spot. */
export function rank(places, middle, starts, radiusM, count) {
  const seen = new Set();
  return places
    .map((place) => ({ place, distance: distanceMeters(middle, place) }))
    .filter(({ distance }) => distance <= radiusM)
    .sort((a, b) => a.distance - b.distance)
    .filter(({ place }) => {
      const key = `${place.name.toLowerCase()}@${place.lat.toFixed(3)},${place.lng.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count)
    .map(({ place, distance }) => ({
      name: place.name.slice(0, 200),
      ...(place.address ? { address: place.address.slice(0, 500) } : {}),
      ...(place.kind ? { kind: place.kind } : {}),
      ...(place.phone ? { phone: place.phone } : {}),
      ...(place.url ? { url: place.url } : {}),
      lat: place.lat,
      lng: place.lng,
      distanceM: Math.round(distance),
      fromStartsM: starts.map((start) => Math.round(distanceMeters(start, place))),
    }));
}

/** body is the parsed CLI request ({ from, what, count, radiusM, country }); maps is from apple.js. */
export async function findMiddleLocally(body, maps, { me = null } = {}) {
  const what = body.what ?? 'cafés';
  const count = body.count ?? 5;
  const radiusM = body.radiusM ?? 1000;
  if (count < 2 || count > 10) throw new LocalSearchError('--count must be from 2 to 10');
  if (radiusM < 100 || radiusM > MAX_RADIUS_M) throw new LocalSearchError('--radius must be from 100 to 5000 metres');
  if (body.from.length + (me ? 1 : 0) > 8) throw new LocalSearchError('Give at most 8 starting places.');

  const starts = me ? [{ name: me.name ?? 'you', lat: me.lat, lng: me.lng }] : [];
  for (const [index, text] of body.from.entries()) {
    const coordinates = COORDINATES.exec(text);
    if (coordinates) {
      starts.push({ name: text.trim(), lat: Number(coordinates[1]), lng: Number(coordinates[2]) });
      continue;
    }
    const found = await maps.geocode(text, body.country);
    if (!found) throw new LocalSearchError(`Couldn't find starting place ${index + 1}, "${text}". Try a town, station, street or postcode.`);
    starts.push(found);
  }

  const middle = midpointOf(starts);
  const area = await maps.reverse(middle);
  const located = {
    midpoint: { ...middle, label: area?.label ?? 'the middle', ...(area?.regionLabel ? { regionLabel: area.regionLabel } : {}) },
    spreadM: spread(starts),
    startingPoints: starts.map(({ name, lat, lng }) => ({ name, lat, lng })),
  };

  let candidates = [];
  let searched = radiusM;
  for (const radius of radiusSteps(radiusM)) {
    searched = radius;
    candidates = rank(await maps.search(what, middle, radius), middle, starts, radius, count);
    if (candidates.length >= count) break;
  }

  return {
    source: 'apple',
    what: { query: what, label: what, unchecked: [] },
    ...located,
    radiusM: searched,
    candidates,
    note: 'Straight-line middle, not travel time.',
    area: area?.countryCode ? { label: located.midpoint.label, ...(area.regionLabel ? { regionLabel: area.regionLabel } : {}), countryCode: area.countryCode } : null,
  };
}

/** The /api/middle "places" request: the midpoint and chosen places only. */
export function placesRequest(summary, body) {
  return {
    midpoint: { lat: summary.midpoint.lat, lng: summary.midpoint.lng },
    places: summary.candidates.map(({ name, lat, lng, address, kind }) => ({ name, lat, lng, ...(address ? { address } : {}), ...(kind ? { kind } : {}) })),
    ...(summary.area ? { area: summary.area } : {}),
    what: summary.what.query,
    radiusM: summary.radiusM,
    // Lets ChattyMaps credit Apple Maps on the poll's map.
    source: 'apple_maps',
    ...(body.title ? { title: body.title } : {}),
    ...(body.nickname ? { nickname: body.nickname } : {}),
    ...(body.expiresIn ? { expiresIn: body.expiresIn } : {}),
  };
}
