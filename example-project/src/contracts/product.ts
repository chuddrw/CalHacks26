/**
 * src/contracts/product.ts
 *
 * WHAT IT'S FOR
 *   The Product type shared by the catalog, the cart and checkout: the contract between them.
 *   Prices are integer cents in USD, never dollars or floats, so totals add up exactly.
 *
 * OWNER: shared (src/contracts/). The catalog agent writes the baseline.
 */
export interface Product {
  id: string;
  name: string;
  description: string;
  /** URL of the product image. */
  image: string;
  /** Price in integer cents, USD. 1999 means $19.99. */
  priceCents: number;
}
