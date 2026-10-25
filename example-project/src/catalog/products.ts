/**
 * src/catalog/products.ts
 *
 * WHAT IT'S FOR
 *   Mock product data for the catalog, kept apart from the UI in catalog.ts so it can be swapped
 *   for a real product source without touching the rendering code.
 *
 * OWNER: the catalog agent.
 */
import type { Product } from "../contracts/product";

function placeholderImage(label: string): string {
  return `https://placehold.co/480x360?text=${encodeURIComponent(label)}`;
}

export const PRODUCTS: readonly Product[] = [
  {
    id: "p-mug",
    name: "Ceramic Mug",
    description: "A 12 oz stoneware mug with a matte glaze. Dishwasher safe.",
    image: placeholderImage("Ceramic Mug"),
    priceCents: 1499,
  },
  {
    id: "p-tote",
    name: "Canvas Tote",
    description: "Heavy cotton canvas tote with an inner pocket and long handles.",
    image: placeholderImage("Canvas Tote"),
    priceCents: 2200,
  },
  {
    id: "p-notebook",
    name: "Dot-Grid Notebook",
    description: "A5 notebook with 160 pages of fountain-pen friendly paper.",
    image: placeholderImage("Notebook"),
    priceCents: 1250,
  },
  {
    id: "p-bottle",
    name: "Steel Water Bottle",
    description: "Insulated 750 ml bottle that keeps drinks cold for 24 hours.",
    image: placeholderImage("Water Bottle"),
    priceCents: 2999,
  },
  {
    id: "p-headphones",
    name: "Wireless Headphones",
    description: "Over-ear headphones with 30-hour battery life and a fold-flat design.",
    image: placeholderImage("Headphones"),
    priceCents: 8900,
  },
  {
    id: "p-plant",
    name: "Desk Plant",
    description: "A low-light snake plant in a 4 inch ceramic pot.",
    image: placeholderImage("Desk Plant"),
    priceCents: 1800,
  },
  {
    id: "p-candle",
    name: "Soy Candle",
    description: "Hand-poured cedar and sage candle with about 40 hours of burn time.",
    image: placeholderImage("Soy Candle"),
    priceCents: 1600,
  },
  {
    id: "p-socks",
    name: "Wool Socks",
    description: "Merino wool blend crew socks, one pair.",
    image: placeholderImage("Wool Socks"),
    priceCents: 995,
  },
];
