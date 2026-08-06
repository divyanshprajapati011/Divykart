const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "products.json");
const BANNERS_FILE = path.join(__dirname, "data", "banners.json");
const REVIEWS_FILE = path.join(__dirname, "data", "reviews.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// Fashion is the only category with shopper-facing sub-categories today.
// Kept server-side too so validation/admin tooling can share this list.
const FASHION_SUBCATEGORIES = ["Men", "Women", "Kids"];

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Serve uploaded product images statically
app.use("/uploads", express.static(UPLOADS_DIR));

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const sessions = new Map();

/* ------------------------------------------------------------------ */
/* Products.json helpers                                              */
/* ------------------------------------------------------------------ */

async function readProducts() {
  const raw = await fs.readFile(DATA_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeProducts(products) {
  const temp = DATA_FILE + ".tmp";
  await fs.writeFile(temp, JSON.stringify(products, null, 2), "utf8");
  await fs.rename(temp, DATA_FILE);
}

// Generic read/write helpers for the banners + reviews JSON stores. Both
// files are created with an empty/default array the first time the server
// starts if they don't already exist, so upgrading an older install never
// crashes on a missing file.
async function readJsonArray(file, fallback = []) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(file, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    throw err;
  }
}

async function writeJsonArray(file, data) {
  const temp = file + ".tmp";
  await fs.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(temp, file);
}

const DEFAULT_BANNERS = [
  {
    id: "b1",
    tag: "DIVYKART • FLASH SALE",
    title: "Smart deals. Better prices. One place.",
    subtitle: "Discover handpicked products and compare the best offers from India's favourite shopping platforms.",
    gradientFrom: "#102b91",
    gradientTo: "#4f8dfb",
    buttonText: "Explore Deals",
    buttonAction: "scroll",
    secondaryText: "View Biggest Discounts",
    secondaryAction: "deals",
    order: 1
  },
  {
    id: "b2",
    tag: "FASHION EDIT • UP TO 70% OFF",
    title: "Upgrade your style without overspending.",
    subtitle: "Trending fashion, beauty and everyday essentials — curated for smarter shopping.",
    gradientFrom: "#64145f",
    gradientTo: "#d946ef",
    buttonText: "Shop Fashion",
    buttonAction: "category:Fashion",
    secondaryText: "",
    secondaryAction: "",
    order: 2
  },
  {
    id: "b3",
    tag: "HOME & KITCHEN • SMART SHOPPING",
    title: "Make every corner of your home better.",
    subtitle: "Explore useful kitchen, appliance and home products at prices worth checking.",
    gradientFrom: "#a83b0b",
    gradientTo: "#fb923c",
    buttonText: "Explore Kitchen",
    buttonAction: "category:Kitchen",
    secondaryText: "",
    secondaryAction: "",
    order: 3
  }
];

async function readBanners() {
  const banners = await readJsonArray(BANNERS_FILE, DEFAULT_BANNERS);
  return banners.sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function readReviews() {
  return readJsonArray(REVIEWS_FILE, []);
}

// Recomputes a product's `rating` and `reviewCount` from its review list and
// persists the change to products.json, so the storefront card/detail view
// always reflects real shopper feedback.
async function recomputeProductRating(productId) {
  const [products, reviews] = await Promise.all([readProducts(), readReviews()]);
  const index = products.findIndex((p) => p.id === productId);
  if (index === -1) return null;

  const productReviews = reviews.filter((r) => r.productId === productId);
  if (productReviews.length) {
    const avg = productReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / productReviews.length;
    products[index].rating = Math.round(avg * 10) / 10;
    products[index].reviewCount = productReviews.length;
  }
  await writeProducts(products);
  return products[index];
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function authRequired(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Image upload system (Multer)                                       */
/* ------------------------------------------------------------------ */

// Map of accepted MIME types -> file extension. Anything else is rejected.
const ALLOWED_MIME_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

// Validates that a stored image path is a well-formed, safe path that lives
// inside our uploads directory. Used to prevent directory traversal when
// deleting files based on client-supplied strings.
function isValidUploadPath(p) {
  if (typeof p !== "string") return false;
  if (p.includes("..")) return false;
  return /^\/uploads\/[a-zA-Z0-9_-]+\/[a-f0-9]+\.(jpg|jpeg|png|webp)$/.test(p);
}

// Every upload request gets its own randomly named batch folder, e.g.
// uploads/1748593948123-a1b2c3d4/. This keeps images from a single
// product upload grouped together and guarantees unique filenames.
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      if (!req.uploadBatchDir) {
        const batchId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        req.uploadBatchDir = path.join(UPLOADS_DIR, batchId);
        await fs.mkdir(req.uploadBatchDir, { recursive: true });
      }
      cb(null, req.uploadBatchDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME_TYPES[file.mimetype] || path.extname(file.originalname) || "";
    const randomName = crypto.randomBytes(16).toString("hex");
    cb(null, `${randomName}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  if (ALLOWED_MIME_TYPES[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error("UNSUPPORTED_FILE_TYPE"));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_IMAGE_SIZE, files: MAX_IMAGES }
});

// Deletes a list of stored image files from disk. Silently ignores files
// that are already gone or whose paths fail validation.
async function deleteImageFiles(imagePaths = []) {
  for (const imgPath of imagePaths) {
    if (!isValidUploadPath(imgPath)) continue;
    const absolute = path.join(__dirname, imgPath);
    await fs.unlink(absolute).catch(() => {});
  }
}

// After deleting files, removes any now-empty batch folders so the
// uploads directory doesn't accumulate empty subfolders over time.
async function cleanupEmptyBatchDirs(imagePaths = []) {
  const dirs = new Set(
    imagePaths.filter(isValidUploadPath).map((p) => path.dirname(path.join(__dirname, p)))
  );
  for (const dir of dirs) {
    try {
      const remaining = await fs.readdir(dir);
      if (remaining.length === 0) await fs.rmdir(dir);
    } catch {
      // Directory may already be gone or non-empty; ignore.
    }
  }
}

// POST /api/upload-images
// Accepts up to 10 image files (field name "images"), validates type/size,
// stores them under /uploads/<batch>/<random-name>.ext and returns their
// public paths for the client to attach to a product.
app.post("/api/upload-images", authRequired, (req, res) => {
  upload.array("images", MAX_IMAGES)(req, res, async (err) => {
    if (err) {
      // Clean up any partially written files from this failed batch.
      if (req.uploadBatchDir) {
        await fs.rm(req.uploadBatchDir, { recursive: true, force: true }).catch(() => {});
      }
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "Each image must be 5MB or smaller" });
        }
        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({ error: "You can upload a maximum of 10 images per product" });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err.message === "UNSUPPORTED_FILE_TYPE") {
        return res.status(400).json({ error: "Only JPG, JPEG, PNG and WEBP images are allowed" });
      }
      console.error(err);
      return res.status(500).json({ error: "Image upload failed" });
    }

    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: "No images were received" });
    }

    const batchFolder = path.basename(req.uploadBatchDir);
    const images = req.files.map((f) => `/uploads/${batchFolder}/${f.filename}`);
    res.status(201).json({ images });
  });
});

// DELETE /api/upload-images
// Removes a single previously uploaded image from disk (used when the
// admin removes an image while creating/editing a product).
app.delete("/api/upload-images", authRequired, async (req, res) => {
  try {
    const { path: imgPath } = req.body || {};
    if (!isValidUploadPath(imgPath)) {
      return res.status(400).json({ error: "Invalid image path" });
    }
    await deleteImageFiles([imgPath]);
    await cleanupEmptyBatchDirs([imgPath]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete image" });
  }
});

/* ------------------------------------------------------------------ */
/* Product validation                                                  */
/* ------------------------------------------------------------------ */

function validateProduct(input, partial = false) {
  const errors = [];
  if (!partial || input.name !== undefined) {
    if (!String(input.name || "").trim()) errors.push("Product name is required");
  }
  if (!partial || input.category !== undefined) {
    if (!String(input.category || "").trim()) errors.push("Category is required");
  }
  if (!partial || input.platform !== undefined) {
    if (!String(input.platform || "").trim()) errors.push("Platform is required");
  }
  if (input.price !== undefined && (!Number.isFinite(Number(input.price)) || Number(input.price) < 0)) errors.push("Invalid original price");
  if (input.discountPrice !== undefined && (!Number.isFinite(Number(input.discountPrice)) || Number(input.discountPrice) < 0)) errors.push("Invalid discount price");
  if (input.rating !== undefined && (!Number.isFinite(Number(input.rating)) || Number(input.rating) < 0 || Number(input.rating) > 5)) errors.push("Rating must be between 0 and 5");
  if (input.images !== undefined) {
    if (!Array.isArray(input.images)) {
      errors.push("Images must be an array");
    } else if (input.images.length > MAX_IMAGES) {
      errors.push(`A product can have a maximum of ${MAX_IMAGES} images`);
    } else if (input.images.some((p) => !isValidUploadPath(p))) {
      errors.push("One or more image paths are invalid");
    }
  }
  if (input.affiliateUrl !== undefined && input.affiliateUrl && !/^https?:\/\//i.test(input.affiliateUrl)) errors.push("Affiliate URL must start with http:// or https://");
  if (input.subCategory !== undefined && input.subCategory && !FASHION_SUBCATEGORIES.includes(input.subCategory)) {
    errors.push(`Sub-category must be one of: ${FASHION_SUBCATEGORIES.join(", ")}`);
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Public product routes                                               */
/* ------------------------------------------------------------------ */

app.get("/api/products", async (req, res) => {
  try {
    const products = await readProducts();
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read products.json" });
  }
});

/* ------------------------------------------------------------------ */
/* Homepage banner ("canvas") routes                                   */
/* Lets the admin edit the hero slides shown on the storefront without */
/* touching any code — title, subtitle, gradient colors and CTA are    */
/* all stored in data/banners.json and rendered dynamically.           */
/* ------------------------------------------------------------------ */

app.get("/api/banners", async (req, res) => {
  try {
    const banners = await readBanners();
    res.json(banners);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read banners" });
  }
});

function validateBanner(input) {
  const errors = [];
  if (!String(input.title || "").trim()) errors.push("Banner title is required");
  if (input.gradientFrom && !/^#[0-9a-f]{6}$/i.test(input.gradientFrom)) errors.push("gradientFrom must be a hex color like #102b91");
  if (input.gradientTo && !/^#[0-9a-f]{6}$/i.test(input.gradientTo)) errors.push("gradientTo must be a hex color like #4f8dfb");
  return errors;
}

app.post("/api/banners", authRequired, async (req, res) => {
  try {
    const errors = validateBanner(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(", ") });

    const banners = await readBanners();
    const banner = {
      id: `bn${Date.now()}`,
      tag: String(req.body.tag || "").trim(),
      title: String(req.body.title).trim(),
      subtitle: String(req.body.subtitle || "").trim(),
      gradientFrom: req.body.gradientFrom || "#2563eb",
      gradientTo: req.body.gradientTo || "#4f8dfb",
      buttonText: String(req.body.buttonText || "Explore").trim(),
      buttonAction: String(req.body.buttonAction || "scroll").trim(),
      secondaryText: String(req.body.secondaryText || "").trim(),
      secondaryAction: String(req.body.secondaryAction || "").trim(),
      order: Number.isFinite(Number(req.body.order)) ? Number(req.body.order) : banners.length + 1
    };
    banners.push(banner);
    await writeJsonArray(BANNERS_FILE, banners);
    res.status(201).json(banner);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save banner" });
  }
});

app.put("/api/banners/:id", authRequired, async (req, res) => {
  try {
    const errors = validateBanner({ ...req.body, title: req.body.title ?? "x" });
    if (req.body.title !== undefined && !String(req.body.title).trim()) errors.push("Banner title is required");
    if (errors.length) return res.status(400).json({ error: errors.join(", ") });

    const banners = await readBanners();
    const index = banners.findIndex((b) => b.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Banner not found" });

    banners[index] = { ...banners[index], ...req.body, id: banners[index].id };
    await writeJsonArray(BANNERS_FILE, banners);
    res.json(banners[index]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update banner" });
  }
});

app.delete("/api/banners/:id", authRequired, async (req, res) => {
  try {
    const banners = await readBanners();
    const next = banners.filter((b) => b.id !== req.params.id);
    if (next.length === banners.length) return res.status(404).json({ error: "Banner not found" });
    await writeJsonArray(BANNERS_FILE, next);
    res.json({ ok: true, deletedId: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete banner" });
  }
});

/* ------------------------------------------------------------------ */
/* Product reviews & ratings                                           */
/* Shoppers can post a name + star rating + comment against any        */
/* product. The product's average rating/reviewCount is recomputed and */
/* persisted every time a review is added or removed.                  */
/* ------------------------------------------------------------------ */

app.get("/api/products/:id/reviews", async (req, res) => {
  try {
    const reviews = await readReviews();
    const productReviews = reviews
      .filter((r) => r.productId === req.params.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(productReviews);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read reviews" });
  }
});

app.post("/api/products/:id/reviews", async (req, res) => {
  try {
    const { name, rating, comment } = req.body || {};
    const errors = [];
    if (!String(name || "").trim()) errors.push("Name is required");
    const ratingNum = Number(rating);
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) errors.push("Rating must be between 1 and 5");
    if (!String(comment || "").trim()) errors.push("Review comment is required");
    if (String(comment || "").length > 1000) errors.push("Review comment must be under 1000 characters");
    if (errors.length) return res.status(400).json({ error: errors.join(", ") });

    const products = await readProducts();
    if (!products.some((p) => p.id === req.params.id)) {
      return res.status(404).json({ error: "Product not found" });
    }

    const reviews = await readReviews();
    const review = {
      id: `rv${Date.now()}${Math.floor(Math.random() * 1000)}`,
      productId: req.params.id,
      name: String(name).trim().slice(0, 60),
      rating: ratingNum,
      comment: String(comment).trim().slice(0, 1000),
      createdAt: Date.now()
    };
    reviews.push(review);
    await writeJsonArray(REVIEWS_FILE, reviews);

    const updatedProduct = await recomputeProductRating(req.params.id);
    res.status(201).json({ review, product: updatedProduct });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save review" });
  }
});

// Admin-only moderation: remove an inappropriate/spam review.
app.delete("/api/reviews/:id", authRequired, async (req, res) => {
  try {
    const reviews = await readReviews();
    const target = reviews.find((r) => r.id === req.params.id);
    if (!target) return res.status(404).json({ error: "Review not found" });

    const next = reviews.filter((r) => r.id !== req.params.id);
    await writeJsonArray(REVIEWS_FILE, next);
    const updatedProduct = await recomputeProductRating(target.productId);
    res.json({ ok: true, deletedId: req.params.id, product: updatedProduct });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete review" });
  }
});

app.get("/api/reviews", authRequired, async (req, res) => {
  try {
    const reviews = await readReviews();
    res.json(reviews.sort((a, b) => b.createdAt - a.createdAt));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read reviews" });
  }
});

/* ------------------------------------------------------------------ */
/* Admin auth routes                                                   */
/* ------------------------------------------------------------------ */

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, createdAt: Date.now() });
  res.json({ token, username });
});

app.post("/api/admin/logout", authRequired, (req, res) => {
  const token = req.headers.authorization.replace(/^Bearer\s+/i, "");
  sessions.delete(token);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Product CRUD routes                                                 */
/* ------------------------------------------------------------------ */

app.post("/api/products", authRequired, async (req, res) => {
  try {
    const errors = validateProduct(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(", ") });

    const products = await readProducts();
    const now = Date.now();
    const product = {
      id: String(req.body.id || `p${now}`),
      name: String(req.body.name).trim(),
      category: String(req.body.category).trim(),
      platform: String(req.body.platform).trim(),
      brand: String(req.body.brand || "Generic").trim(),
      price: Number(req.body.price || 0),
      discountPrice: Number(req.body.discountPrice || 0),
      discountPercent: Math.max(0, Math.round((1 - Number(req.body.discountPrice || 0) / Math.max(Number(req.body.price || 1), 1)) * 100)),
      rating: Number(req.body.rating ?? 4),
      reviewCount: Number(req.body.reviewCount || 0),
      // Images are now server-stored file paths (e.g. /uploads/<batch>/<file>.webp)
      // produced by POST /api/upload-images, never raw URLs or Base64.
      images: Array.isArray(req.body.images) ? req.body.images : [],
      deliveryBadge: String(req.body.deliveryBadge || "Free Delivery in 3 Days"),
      stockStatus: String(req.body.stockStatus || "In Stock"),
      offerTag: req.body.offerTag || null,
      // Only meaningful for category === "Fashion" today (Men / Women / Kids),
      // but stored generically in case other categories grow sub-categories later.
      subCategory: req.body.subCategory || null,
      description: String(req.body.description || ""),
      affiliateUrl: String(req.body.affiliateUrl || ""),
      // Timestamp of when the price was last set/verified. Shown to
      // shoppers so they know prices can drift from the source platform.
      priceUpdatedAt: now,
      specs: Array.isArray(req.body.specs) ? req.body.specs : [
        ["Brand", String(req.body.brand || "Generic")],
        ["Category", String(req.body.category).trim()],
        ["Platform", String(req.body.platform).trim()],
        ["Availability", String(req.body.stockStatus || "In Stock")]
      ]
    };
    if (products.some(p => p.id === product.id)) return res.status(409).json({ error: "Product ID already exists" });
    products.unshift(product);
    await writeProducts(products);
    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save product" });
  }
});

app.put("/api/products/:id", authRequired, async (req, res) => {
  try {
    const errors = validateProduct(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join(", ") });

    const products = await readProducts();
    const index = products.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Product not found" });

    const old = products[index];
    const merged = { ...old, ...req.body, id: old.id };
    if (merged.price !== undefined && merged.discountPrice !== undefined) {
      merged.price = Number(merged.price);
      merged.discountPrice = Number(merged.discountPrice);
      merged.discountPercent = Math.max(0, Math.round((1 - merged.discountPrice / Math.max(merged.price, 1)) * 100));
    }
    // Whenever either price field actually changes, stamp the moment so the
    // storefront can tell shoppers how fresh (or stale) that price is.
    const priceChanged = Number(req.body.price) !== Number(old.price) || Number(req.body.discountPrice) !== Number(old.discountPrice);
    if ((req.body.price !== undefined || req.body.discountPrice !== undefined) && priceChanged) {
      merged.priceUpdatedAt = Date.now();
    }
    products[index] = merged;
    await writeProducts(products);

    // If the images array changed, remove any files that were dropped
    // from the product so we never leave orphaned uploads on disk.
    if (Array.isArray(req.body.images)) {
      const oldImages = Array.isArray(old.images) ? old.images : [];
      const removed = oldImages.filter((img) => !merged.images.includes(img));
      if (removed.length) {
        await deleteImageFiles(removed);
        await cleanupEmptyBatchDirs(removed);
      }
    }

    res.json(merged);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update product" });
  }
});

app.delete("/api/products/:id", authRequired, async (req, res) => {
  try {
    const products = await readProducts();
    const target = products.find(p => p.id === req.params.id);
    if (!target) return res.status(404).json({ error: "Product not found" });

    const next = products.filter(p => p.id !== req.params.id);
    await writeProducts(next);

    // Clean up the product's uploaded images from disk.
    const images = Array.isArray(target.images) ? target.images : [];
    if (images.length) {
      await deleteImageFiles(images);
      await cleanupEmptyBatchDirs(images);
    }

    res.json({ ok: true, deletedId: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete product" });
  }
});

/* ------------------------------------------------------------------ */
/* Admin panel + startup                                               */
/* ------------------------------------------------------------------ */

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin", "index.html")));
app.get("/admin/", (req, res) => res.sendFile(path.join(__dirname, "admin", "index.html")));

async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

ensureUploadsDir().then(() => {
  app.listen(PORT, () => {
    console.log(`DivyKart running at http://localhost:${PORT}`);
    console.log(`Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`Data file: ${DATA_FILE}`);
    console.log(`Uploads folder: ${UPLOADS_DIR}`);
  });
});
