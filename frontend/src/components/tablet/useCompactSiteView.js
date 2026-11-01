import { useEffect, useState } from 'react';

/** Observe the relevant layout breakpoint, including device rotation. */
export function useCompactSiteView(query = '(max-width: 767px)') {
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return compact;
}
