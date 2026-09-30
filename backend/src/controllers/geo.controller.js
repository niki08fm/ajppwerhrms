import { geoSearchSchema } from '@ajpwer/shared';
import { asyncHandler } from '../utils/asyncHandler.js';
import { geoSearch } from '../services/geo.service.js';

/** GET /geo/search?q= — place search for the site map, via our Nominatim proxy. */
export const searchPlaces = asyncHandler(async (req, res) => {
  const { q } = geoSearchSchema.parse({ q: req.query.q ?? '' });
  const { results, cached } = await geoSearch.search(q);
  res.json({ data: results, meta: { cached } });
});
