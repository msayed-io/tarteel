export interface ReverseGeocodeResult {
  placeName: string;
  countryName: string;
  displayAddress?: string;
  source: "nominatim" | "bigdatacloud" | "arcgis" | "photon";
}

function firstNonEmpty(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || "";
}

/**
 * استخراج أدق وأوضح اسم محلي للموقع (مسجد، معلم، عزبة، قرية، نجع، حي، شارع)
 * بحيث يعبر عن المكان المحدد نفسه بدقة متناهية وليس مجرد اسم المدينة الكبرى
 */
function buildNominatimHierarchy(address: Record<string, unknown>): string {
  if (!address) return "";
  const villageOrNeighbourhood = firstNonEmpty(
    address.neighbourhood as string | undefined,
    address.suburb as string | undefined,
    address.quarter as string | undefined,
    address.village as string | undefined,
    address.hamlet as string | undefined,
    address.residential as string | undefined,
    address.isolated_dwelling as string | undefined,
    address.amenity as string | undefined,
    address.place_of_worship as string | undefined,
    address.mosque as string | undefined,
    address.building as string | undefined,
    address.road as string | undefined
  );
  const cityOrCenter = firstNonEmpty(
    address.city as string | undefined,
    address.town as string | undefined,
    address.locality as string | undefined,
    address.city_district as string | undefined,
    address.district as string | undefined,
    address.municipality as string | undefined,
    address.borough as string | undefined,
    address.county as string | undefined
  );
  const governorateOrState = firstNonEmpty(
    address.state as string | undefined,
    address.state_district as string | undefined,
    address.governorate as string | undefined,
    address.province as string | undefined
  );

  const parts = [];
  if (villageOrNeighbourhood) parts.push(villageOrNeighbourhood);
  if (cityOrCenter && cityOrCenter !== villageOrNeighbourhood) parts.push(cityOrCenter);
  if (governorateOrState && governorateOrState !== cityOrCenter) parts.push(governorateOrState);

  return parts.join("، ");
}

function buildBDCHierarchy(data: Record<string, unknown>): string {
  if (!data) return "";
  const localityInfo = (data.localityInfo as Record<string, unknown>) || {};
  const administrative = Array.isArray(localityInfo.administrative) ? localityInfo.administrative : [];
  const informative = Array.isArray(localityInfo.informative) ? localityInfo.informative : [];
  
  let neighborhood = "";
  let city = "";
  let governorate = "";

  for (const item of [...informative, ...administrative]) {
    if (item && typeof item === "object" && typeof item.name === "string" && item.name.trim()) {
      const name = item.name.trim();
      const desc = String(item.description || "").toLowerCase();
      const adminLevel = Number(item.adminLevel);
      const order = Number(item.order);

      if (desc.includes("village") || desc.includes("hamlet") || desc.includes("suburb") || desc.includes("neighbourhood") || desc.includes("quarter") || order >= 6 || adminLevel >= 8) {
        if (!neighborhood) neighborhood = name;
      } else if (desc.includes("city") || desc.includes("town") || desc.includes("district") || desc.includes("municipality") || order === 4 || adminLevel === 6) {
        if (!city) city = name;
      } else if (desc.includes("governorate") || desc.includes("province") || desc.includes("state") || order === 2 || adminLevel === 4) {
        if (!governorate) governorate = name;
      }
    }
  }

  const parts = [];
  if (neighborhood) parts.push(neighborhood);
  if (city && city !== neighborhood) parts.push(city);
  if (governorate && governorate !== city) parts.push(governorate);

  if (parts.length === 0) {
    const loc = firstNonEmpty(data.locality as string | undefined, data.city as string | undefined, data.principalSubdivision as string | undefined);
    if (loc) parts.push(loc);
  }

  return parts.join("، ");
}

function buildArcGISHierarchy(address: Record<string, unknown>): string {
  if (!address) return "";
  const neighborhood = firstNonEmpty(
    address.PlaceName as string | undefined,
    address.PointOfInterest as string | undefined,
    address.Neighborhood as string | undefined,
    address.Street as string | undefined,
    address.Address as string | undefined,
    address.Village as string | undefined,
    address.Hamlet as string | undefined
  );
  const city = firstNonEmpty(
    address.City as string | undefined,
    address.Locality as string | undefined,
    address.District as string | undefined,
    address.Municipality as string | undefined
  );
  const governorate = firstNonEmpty(
    address.Subregion as string | undefined,
    address.County as string | undefined,
    address.Region as string | undefined
  );

  const parts = [];
  if (neighborhood) parts.push(neighborhood);
  if (city && city !== neighborhood) parts.push(city);
  if (governorate && governorate !== city) parts.push(governorate);

  return parts.join("، ");
}

function buildPhotonHierarchy(properties: Record<string, unknown>): string {
  if (!properties) return "";
  const neighborhood = firstNonEmpty(
    properties.name as string | undefined,
    properties.street as string | undefined,
    properties.hamlet as string | undefined,
    properties.village as string | undefined,
    properties.neighbourhood as string | undefined,
    properties.suburb as string | undefined
  );
  const city = firstNonEmpty(
    properties.locality as string | undefined,
    properties.town as string | undefined,
    properties.district as string | undefined,
    properties.city as string | undefined,
    properties.municipality as string | undefined
  );
  const governorate = firstNonEmpty(
    properties.county as string | undefined,
    properties.state as string | undefined
  );

  const parts = [];
  if (neighborhood) parts.push(neighborhood);
  if (city && city !== neighborhood) parts.push(city);
  if (governorate && governorate !== city) parts.push(governorate);

  return parts.join("، ");
}

export async function reverseGeocodeCoordinates(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeResult | null> {
  const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1&namedetails=1&accept-language=ar`;
  const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=ar`;
  const arcgisUrl = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${longitude},${latitude}&f=json&langCode=ARA`;
  const photonUrl = `https://photon.komoot.io/reverse?lat=${latitude}&lon=${longitude}`;

  const [nominatimResult, bdcResult, arcgisResult, photonResult] = await Promise.allSettled([
    fetch(nominatimUrl, {
      headers: {
        "Accept-Language": "ar",
        "User-Agent": "DarAlHikayatApp/1.0 (PrayerLocationService)",
      },
      signal: AbortSignal.timeout(4500),
    }).then((response) => (response.ok ? response.json() : null)),
    fetch(bdcUrl, {
      signal: AbortSignal.timeout(4500),
    }).then((response) => (response.ok ? response.json() : null)),
    fetch(arcgisUrl, { signal: AbortSignal.timeout(4500) }).then((response) =>
      response.ok ? response.json() : null,
    ),
    fetch(photonUrl, {
      headers: {
        "Accept-Language": "ar",
        "User-Agent": "DarAlHikayatApp/1.0 (PrayerLocationService)",
      },
      signal: AbortSignal.timeout(4500),
    }).then((response) => (response.ok ? response.json() : null)),
  ]);

  const nominatim = nominatimResult.status === "fulfilled" ? nominatimResult.value : null;
  const bdc = bdcResult.status === "fulfilled" ? bdcResult.value : null;
  const arcgis = arcgisResult.status === "fulfilled" ? arcgisResult.value : null;
  const photon = photonResult.status === "fulfilled" ? photonResult.value : null;

  const nominatimAddress = (nominatim?.address as Record<string, unknown>) || {};
  const arcgisAddress = (arcgis?.address as Record<string, unknown>) || {};
  const photonProperties = (photon?.features?.[0]?.properties as Record<string, unknown>) || {};

  const nominatimHierarchy = buildNominatimHierarchy(nominatimAddress);
  const bdcHierarchy = bdc ? buildBDCHierarchy(bdc as Record<string, unknown>) : "";
  const arcgisHierarchy = buildArcGISHierarchy(arcgisAddress);
  const photonHierarchy = buildPhotonHierarchy(photonProperties);

  const candidates: ReverseGeocodeResult[] = [
    {
      placeName: arcgisHierarchy,
      countryName: firstNonEmpty(arcgisAddress.Country as string | undefined),
      displayAddress: firstNonEmpty(arcgisAddress.Match_addr as string | undefined, arcgisAddress.Address as string | undefined),
      source: "arcgis",
    },
    {
      placeName: bdcHierarchy,
      countryName: firstNonEmpty(bdc?.countryName as string | undefined),
      displayAddress: firstNonEmpty(bdc?.locality as string | undefined, bdc?.city as string | undefined, bdc?.countryName as string | undefined),
      source: "bigdatacloud",
    },
    {
      placeName: nominatimHierarchy,
      countryName: firstNonEmpty(nominatimAddress.country as string | undefined),
      displayAddress: firstNonEmpty(nominatim?.display_name as string | undefined),
      source: "nominatim",
    },
    {
      placeName: photonHierarchy,
      countryName: firstNonEmpty(photonProperties.country as string | undefined),
      displayAddress: firstNonEmpty(photonProperties.name as string | undefined, photonProperties.street as string | undefined, photonProperties.country as string | undefined),
      source: "photon",
    },
  ];

  return candidates.find((candidate) => candidate.placeName || candidate.countryName) || null;
}

export function formatReverseGeocodeFallback(): ReverseGeocodeResult {
  return {
    placeName: "موقع محدد على الخريطة",
    countryName: "",
    source: "nominatim",
  };
}
