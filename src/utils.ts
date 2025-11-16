const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Converts a non-negative integer into a fixed-length Base64URL string.
 */
const intToBase64Url = (num: number, padLength: number): string => {
  let result = '';
  let current = Math.floor(num); // Ensure we have an integer

  if (current === 0) {
    result = 'A'; // 'A' is our 0
  }

  while (current > 0) {
    result = BASE64_CHARS[current % 64] + result;
    current = Math.floor(current / 64);
  }

  // Pad with 'A' (which represents 0) to get the fixed length
  return result.padStart(padLength, 'A');
};

/**
 * Converts a standard string into a Base64URL-encoded string (via UTF-8).
 */
const stringToBase64Url = (str: string): string => {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);

  // Convert Uint8Array to binary string (in chunks to avoid stack overflow)
  let binaryString = '';
  const CHUNK_SIZE = 8192;
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    binaryString += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK_SIZE) as never);
  }

  // Use btoa and then convert to URL-safe variant
  return btoa(binaryString)
    .replace(/\+/g, '-') // Replace + with -
    .replace(/\//g, '_') // Replace / with _
    .replace(/=/g, ''); // Remove padding
};

/**
 * Compresses location data into a URL string.
 * @param baseUrl The base URL of the website
 * @returns A full URL with the compressed 'd' parameter.
 */
export const compressDiscoverUrl = (
  latitude: number,
  longitude: number,
  radius: number,
  name: string,
  baseUrl: string = 'https://nearcade.phizone.cn'
): string => {
  // 1. Encode Latitude (5 chars)
  // We use Math.round to handle potential floating point inaccuracies
  const latInt = Math.round(latitude * 1_000_000 + 90_000_000);
  const latStr = intToBase64Url(latInt, 5);

  // 2. Encode Longitude (5 chars)
  const lonInt = Math.round(longitude * 1_000_000 + 180_000_000);
  const lonStr = intToBase64Url(lonInt, 5);

  // 3. Encode Radius (1 char)
  // Clamp radius between 1 and 30, then store as 0-29
  const clampedRadius = Math.max(1, Math.min(30, radius));
  const radInt = clampedRadius - 1;
  const radStr = intToBase64Url(radInt, 1);

  const prefix = latStr + lonStr + radStr;

  // 4. Encode Name (Variable length)
  const nameBase64 = stringToBase64Url(name);
  const nameStandard = encodeURIComponent(name);

  let namePart: string;

  // Compare lengths. If standard is shorter, use it with the '!' flag.
  // Otherwise, use Base64URL as the default.
  if (nameStandard.length + 1 < nameBase64.length) {
    namePart = '!' + nameStandard;
  } else {
    namePart = nameBase64;
  }

  // 5. Construct final URL
  // We must encode the final 'd' parameter value to be safe
  //   const dParam = encodeURIComponent(prefix + namePart);
  return `${baseUrl.replace(/\/$/, '')}/?d=${prefix}${namePart}`;
};
