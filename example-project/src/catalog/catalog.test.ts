/**
 * src/catalog/catalog.test.ts
 *
 * WHAT IT'S FOR
 *   Tests for the catalog: the mock data follows the Product contract (integer cents), every
 *   product renders with its price and an Add to cart button, and clicking a button calls
 *   addItem with that exact product.
 *
 * OWNER: the catalog agent.
 */
import { describe, expect, it, vi } from "vitest";
import { createCart } from "../cart/cart";
import type { Product } from "../contracts/product";
import { formatPrice, mountCatalog, renderCatalog, type CatalogRoot } from "./catalog";
import { PRODUCTS } from "./products";

function fakeRoot() {
  let listener: ((event: { target: unknown }) => void) | undefined;
  const root: CatalogRoot = {
    innerHTML: "",
    addEventListener: (_type, l) => {
      listener = l;
    },
  };
  const click = (target: unknown) => listener?.({ target });
  return { root, click };
}

function buttonFor(productId: string | null) {
  const button = { getAttribute: (name: string) => (name === "data-product-id" ? productId : null) };
  return { closest: (selector: string) => (selector === "button[data-product-id]" ? button : null) };
}

describe("mock products", () => {
  it("has at least 6 products with unique ids", () => {
    expect(PRODUCTS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PRODUCTS.map((p) => p.id)).size).toBe(PRODUCTS.length);
  });

  it("follows the Product contract with integer cents", () => {
    for (const p of PRODUCTS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.image).toMatch(/^https?:\/\//);
      expect(Number.isInteger(p.priceCents)).toBe(true);
      expect(p.priceCents).toBeGreaterThan(0);
    }
  });
});

describe("formatPrice", () => {
  it("formats integer cents as USD", () => {
    expect(formatPrice(1999)).toBe("$19.99");
    expect(formatPrice(995)).toBe("$9.95");
    expect(formatPrice(8900)).toBe("$89.00");
    expect(formatPrice(123456)).toBe("$1,234.56");
  });
});

describe("renderCatalog", () => {
  it("renders every product with its name, price and an Add to cart button", () => {
    const html = renderCatalog(PRODUCTS);
    for (const p of PRODUCTS) {
      expect(html).toContain(p.name);
      expect(html).toContain(formatPrice(p.priceCents));
      expect(html).toContain(`data-product-id="${p.id}"`);
    }
    expect(html.match(/>Add to cart<\/button>/g)).toHaveLength(PRODUCTS.length);
  });

  it("uses a responsive grid", () => {
    expect(renderCatalog(PRODUCTS)).toMatch(/grid-template-columns: repeat\(auto-fill/);
  });

  it("escapes product text", () => {
    const evil: Product = { id: "x", name: "<b>Hi</b>", description: "a & b", image: "https://e.x/i.png", priceCents: 100 };
    const html = renderCatalog([evil]);
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).not.toContain("<b>Hi</b>");
  });
});

describe("mountCatalog", () => {
  it("renders into the root", () => {
    const { root } = fakeRoot();
    mountCatalog(root, PRODUCTS, () => {});
    expect(root.innerHTML).toBe(renderCatalog(PRODUCTS));
  });

  it("calls addItem with the clicked product", () => {
    const { root, click } = fakeRoot();
    const addItem = vi.fn();
    mountCatalog(root, PRODUCTS, addItem);

    click(buttonFor(PRODUCTS[2].id));

    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith(PRODUCTS[2]);
  });

  it("ignores clicks outside the buttons and unknown ids", () => {
    const { root, click } = fakeRoot();
    const addItem = vi.fn();
    mountCatalog(root, PRODUCTS, addItem);

    click({ closest: () => null });
    click(buttonFor("no-such-product"));
    click(null);

    expect(addItem).not.toHaveBeenCalled();
  });

  it("adds clicked products to the real cart", () => {
    const cart = createCart();
    const { root, click } = fakeRoot();
    mountCatalog(root, PRODUCTS, cart.addItem);

    click(buttonFor(PRODUCTS[0].id));
    click(buttonFor(PRODUCTS[0].id));
    click(buttonFor(PRODUCTS[1].id));

    expect(cart.getItems()).toEqual([
      { product: PRODUCTS[0], quantity: 2 },
      { product: PRODUCTS[1], quantity: 1 },
    ]);
    expect(cart.getTotalCents()).toBe(PRODUCTS[0].priceCents * 2 + PRODUCTS[1].priceCents);
  });
});
