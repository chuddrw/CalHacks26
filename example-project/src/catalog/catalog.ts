/**
 * src/catalog/catalog.ts
 *
 * WHAT IT'S FOR
 *   The product catalog UI, with no framework: renderCatalog builds the HTML for a responsive grid
 *   of product cards, and mountCatalog puts it in the page and wires each "Add to cart" button to
 *   the cart's addItem(product). The catalog never holds cart state; it only calls addItem.
 *
 * OWNER: the catalog agent.
 */
import type { Product } from "../contracts/product";

/** The cart's entry point, provided by the cart agent. */
export type AddItem = (product: Product) => void;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Formats integer USD cents for display: 1999 becomes "$19.99". */
export function formatPrice(priceCents: number): string {
  return usd.format(priceCents / 100);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
.catalog {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 1.5rem;
  padding: 1rem;
  margin: 0;
  list-style: none;
}
.product-card {
  display: flex;
  flex-direction: column;
  border: 1px solid #ddd;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.product-card img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  background: #f2f2f2;
}
.product-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
}
.product-body h2 { margin: 0; font-size: 1.1rem; }
.product-body p { margin: 0; color: #555; flex: 1; }
.product-price { font-weight: 600; font-size: 1.1rem; }
.add-to-cart {
  padding: 0.6rem 1rem;
  border: 0;
  border-radius: 6px;
  background: #1f6feb;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}
.add-to-cart:hover { background: #1a5fd0; }
.add-to-cart:focus-visible { outline: 3px solid #f0b400; outline-offset: 2px; }
`;

function renderCard(product: Product): string {
  const name = escapeHtml(product.name);
  return `<li class="product-card">
  <img src="${escapeHtml(product.image)}" alt="${name}" loading="lazy" />
  <div class="product-body">
    <h2>${name}</h2>
    <p>${escapeHtml(product.description)}</p>
    <span class="product-price">${formatPrice(product.priceCents)}</span>
    <button type="button" class="add-to-cart" data-product-id="${escapeHtml(product.id)}" aria-label="Add ${name} to cart">Add to cart</button>
  </div>
</li>`;
}

/** The catalog's HTML: a style block plus a responsive grid with one card per product. */
export function renderCatalog(products: readonly Product[]): string {
  return `<style>${STYLES}</style>
<ul class="catalog">
${products.map(renderCard).join("\n")}
</ul>`;
}

/** The subset of an element that mountCatalog needs, so tests can pass a stand-in. */
export interface CatalogRoot {
  innerHTML: string;
  addEventListener(type: "click", listener: (event: { target: unknown }) => void): void;
}

interface ClickTarget {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * Renders the catalog into root and calls addItem with the matching product whenever an
 * "Add to cart" button is clicked. One listener on root handles every button.
 */
export function mountCatalog(root: CatalogRoot, products: readonly Product[], addItem: AddItem): void {
  root.innerHTML = renderCatalog(products);
  root.addEventListener("click", (event) => {
    const target = event.target as ClickTarget | null;
    const button = target?.closest?.("button[data-product-id]");
    if (!button) return;
    const product = products.find((p) => p.id === button.getAttribute("data-product-id"));
    if (product) addItem(product);
  });
}
