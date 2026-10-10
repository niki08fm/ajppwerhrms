import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ClipboardPaste, Crosshair, Search } from 'lucide-react';
import { toast } from 'sonner';
import { SITE_RADIUS_MAX_M, SITE_RADIUS_MIN_M } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { parseLatLng, round6 } from '@/utils/geo';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';

// Before a location is chosen the map shows southern India.
const FALLBACK = { lat: 17.385, lng: 78.4867, zoom: 6 };

// A plain dot in the theme's primary colour (no image files to bundle).
const pin = L.divIcon({
  className: '',
  html: '<div style="width:22px;height:22px;border-radius:9999px;background:var(--primary);border:3px solid var(--card);box-shadow:0 1px 4px rgb(0 0 0 / .45)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** Moves the view when the centre is set from outside the map (search, paste, my location). */
function FollowCentre({ centre, seq }) {
  const map = useMap();
  useEffect(() => {
    if (centre && seq > 0) map.flyTo([centre.lat, centre.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps
  // The map opens inside a dialog: measure again once it has its size.
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 150);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

function ClickToPlace({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: round6(e.latlng.lat), lng: round6(e.latlng.lng) }) });
  return null;
}

/**
 * The site's centre and geofence on an OpenStreetMap map: drag the marker or
 * click the map; search a place; paste coordinates or a Google Maps link; or use
 * this device's location. The circle follows the radius as it changes.
 */
export function SiteMap({ lat, lng, radius, onChange, onRadius }) {
  const has = lat !== null && lat !== undefined && lng !== null && lng !== undefined;
  const centre = has ? { lat, lng } : null;
  const [seq, setSeq] = useState(0);
  const markerRef = useRef(null);
  const moveTo = (p) => {
    onChange(p);
    setSeq((n) => n + 1);
  };

  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const search = async (e) => {
    e?.preventDefault();
    if (q.trim().length < 3) return toast.error('Type at least 3 characters to search.');
    setSearching(true);
    try {
      const r = await api.get('/geo/search', { q: q.trim() });
      setResults(r.data);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const [paste, setPaste] = useState('');
  const applyPaste = () => {
    const p = parseLatLng(paste);
    if (!p) return toast.error('No coordinates found. Paste "17.4448, 78.3498" or a Google Maps link with @lat,lng in it.');
    moveTo(p);
    setPaste('');
  };

  const [locating, setLocating] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) return toast.error('This browser has no location service.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        moveTo({ lat: round6(p.coords.latitude), lng: round6(p.coords.longitude) });
        if (p.coords.accuracy > 100) toast.warning(`Your location is only accurate to ${Math.round(p.coords.accuracy)} m. Drag the marker to the exact spot.`);
      },
      (err) => {
        setLocating(false);
        toast.error(err.code === 1 ? 'Location permission was refused. Allow location for this page in the browser.' : 'Location unavailable. Search, paste coordinates or drag the marker instead.');
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  const markerEvents = useMemo(
    () => ({
      dragend: () => {
        const ll = markerRef.current?.getLatLng();
        if (ll) onChange({ lat: round6(ll.lat), lng: round6(ll.lng) });
      },
    }),
    [onChange],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <form onSubmit={search} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a place, e.g. Gachibowli, Hyderabad" aria-label="Search a place" />
          <Button type="submit" variant="outline" loading={searching}>
            <Search /> Search
          </Button>
        </form>
        <Button variant="outline" onClick={locate} loading={locating}>
          <Crosshair /> Use my current location
        </Button>
      </div>
      {results && (
        <div className="max-h-40 overflow-y-auto rounded-md border text-[14px]">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground">No places found. Try a shorter name, or paste coordinates.</p>
          ) : (
            results.map((r) => (
              <button
                key={`${r.lat},${r.lng},${r.name}`}
                type="button"
                className="block w-full border-b px-3 py-1.5 text-left last:border-b-0 hover:bg-accent"
                onClick={() => {
                  moveTo({ lat: r.lat, lng: r.lng });
                  setResults(null);
                }}
              >
                {r.name}
              </button>
            ))
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyPaste())}
          placeholder="Paste Google Maps link or coordinates"
          aria-label="Paste Google Maps link or coordinates"
        />
        <Button variant="outline" onClick={applyPaste} disabled={!paste.trim()}>
          <ClipboardPaste /> Place
        </Button>
      </div>

      <div className="h-72 overflow-hidden rounded-md border">
        <MapContainer center={centre ? [centre.lat, centre.lng] : [FALLBACK.lat, FALLBACK.lng]} zoom={centre ? 16 : FALLBACK.zoom} className="size-full" scrollWheelZoom>
          <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' />
          <FollowCentre centre={centre} seq={seq} />
          <ClickToPlace onPick={onChange} />
          {centre && (
            <>
              <Circle center={[centre.lat, centre.lng]} radius={Number(radius) || 0} pathOptions={{ className: 'site-fence', fillOpacity: 0.12, weight: 2 }} />
              <Marker position={[centre.lat, centre.lng]} icon={pin} draggable eventHandlers={markerEvents} ref={markerRef} />
            </>
          )}
        </MapContainer>
      </div>
      <p className="text-[13px] text-muted-foreground num" aria-live="polite">
        {centre ? `Latitude ${centre.lat.toFixed(6)}, longitude ${centre.lng.toFixed(6)}` : 'No location yet — click the map, search, paste or use your location.'}
      </p>

      <Field label="Geofence radius (metres)" hint={`Between ${SITE_RADIUS_MIN_M} and ${SITE_RADIUS_MAX_M} m. Login works anywhere; punching and face registration require being inside this circle.`}>
        {(id) => (
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={SITE_RADIUS_MIN_M}
              max={SITE_RADIUS_MAX_M}
              step={10}
              value={radius}
              onChange={(e) => onRadius(Number(e.target.value))}
              className="flex-1 accent-[var(--primary)]"
              aria-label="Geofence radius slider"
            />
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={SITE_RADIUS_MIN_M}
              max={SITE_RADIUS_MAX_M}
              value={radius}
              onChange={(e) => onRadius(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-24 num"
            />
          </div>
        )}
      </Field>
    </div>
  );
}
