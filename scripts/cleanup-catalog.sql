-- ---------------------------------------------------------------------------
-- cleanup-catalog.sql — one-shot, RE-RUNNABLE catalog data cleanup.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cleanup-catalog.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v dry_run=1 -f scripts/cleanup-catalog.sql   # ROLLBACK at the end
--
-- Take a backup first (pg_dump -n public -Fc). Everything runs in ONE
-- transaction and prints before/after counts per step.
--
-- Reversibility: every overwritten value is kept under "metadata"
-- (rawPrice / rawSalePrice / rawCompareAtPrice / rawCurrency, rawBrand,
-- rawCategory, rawProductType, rawGender, duplicateOf). A raw value that is
-- already stored is never overwritten, so re-running is a no-op.
--
-- Steps
--   1. Prices   — unconverted JPY rows (graphpaper-tokyo.com, sillage.online)
--   2. Brands   — vendor placeholders / retailer names + spelling variants
--   3. Category — ~1,500 raw multi-language values -> 19 canonical categories
--   4. Gender   — stray "men"/"women", then evidence-based inference
--   5. Dupes    — deactivate rows that are the same product twice
--
-- FX rates (same constants and VAT policy as the crawler's currencyToUsd.ts,
-- so fixed rows line up with their already-converted siblings):
--   JPY -> USD: strip 10% Japanese consumption tax, then 1 USD = 150 JPY
--               usd = round(jpy / 1.10 / 150, 2)
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\pset pager off
BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- lower-case, de-accented, entity-decoded text reduced to [a-z0-9 ] words so
-- that \m \M word-boundary regexes behave ("Men's T-Shirts" -> "mens t shirts").
CREATE FUNCTION pg_temp.norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(regexp_replace(
    translate(
      regexp_replace(
        regexp_replace(lower(coalesce(t, '')), '&(amp;)?(#0?39|#x27|apos|rsquo|quot|amp);', '', 'g'),
        '[''’‘`´]', '', 'g'),
      'àáâäãåçèéêëìíîïñòóôöõøùúûüýÿßœ',
      'aaaaaaceeeeiiiinoooooouuuuyyso'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- brand grouping key: same normalisation with the spaces removed.
CREATE FUNCTION pg_temp.brand_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(pg_temp.norm(t), ' ', '')
$$;

CREATE FUNCTION pg_temp.host(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(substring(u from '://(?:www\.)?([^/:?#]+)'))
$$;

CREATE FUNCTION pg_temp.url_path(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(substring(u from '://[^/]+(/[^?#]*)'), '')
$$;

\echo
\echo ==== BEFORE ====
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE active) AS active_rows,
       count(*) FILTER (WHERE price > 5000) AS price_over_5000,
       max(price) AS max_price,
       count(DISTINCT brand) AS brands,
       count(DISTINCT category) AS categories
FROM "ClothingItem";
SELECT coalesce(gender, '(null)') AS gender, count(*) FROM "ClothingItem" GROUP BY 1 ORDER BY 2 DESC;
SELECT coalesce("productType", '(null)') AS "productType", count(*) FROM "ClothingItem" GROUP BY 1 ORDER BY 2 DESC;

-- ===========================================================================
-- 1. PRICES — unconverted JPY
-- ===========================================================================
-- Evidence: both shops are Japanese and every OTHER row of theirs carries
-- metadata.originalCurrency = 'JPY' with a converted price (Graphpaper median
-- ~$290, max $2,279; Sillage max $1,091). The rows fixed here have no
-- originalCurrency and yen-sized round prices (7,700 – 143,000), with a clean
-- gap between the two populations, so a per-domain floor of 5,000 separates
-- them. All other >5,000 rows (Ball and Buck 9,999.99 placeholders, IWC watch,
-- Vollebak, McCoy's mouton coat) are genuine USD/GBP prices and are left alone.
\echo
\echo ==== 1. prices: unconverted JPY ====
CREATE TEMP TABLE _jpy AS
SELECT id FROM "ClothingItem"
WHERE pg_temp.host("sourceUrl") IN ('graphpaper-tokyo.com', 'sillage.online')
  AND price >= 5000
  AND NOT coalesce(metadata ? 'rawPrice', false)
  AND coalesce(metadata->>'originalCurrency', '') = '';

SELECT brand, count(*) AS rows_to_convert, min(price) AS min_jpy, max(price) AS max_jpy
FROM "ClothingItem" WHERE id IN (SELECT id FROM _jpy) GROUP BY 1 ORDER BY 1;

UPDATE "ClothingItem" c SET
  metadata = coalesce(c.metadata, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
         'rawPrice', c.price,
         'rawSalePrice', c."salePrice",
         'rawCompareAtPrice', c."compareAtPrice",
         'rawCurrency', 'JPY',
         'originalPrice', c.price,
         'originalCurrency', 'JPY',
         'vatRateStripped', 0.1,
         'fxNote', 'cleanup-catalog: JPY/1.10/150 (was stored unconverted as USD)')),
  price = round(c.price / 1.10 / 150, 2),
  "salePrice" = round(c."salePrice" / 1.10 / 150, 2),
  "compareAtPrice" = round(c."compareAtPrice" / 1.10 / 150, 2)
WHERE c.id IN (SELECT id FROM _jpy);

SELECT count(*) FILTER (WHERE price > 5000) AS price_over_5000_after, max(price) AS max_price_after
FROM "ClothingItem";

-- ===========================================================================
-- 2. BRANDS
-- ===========================================================================
\echo
\echo ==== 2. brands ====
CREATE TEMP TABLE _brand_fix (id text PRIMARY KEY, new_brand text NOT NULL);

-- 2a. "Store" = store.toyo-enterprise.co.jp, the Toyo Enterprise house shop.
-- Every product name starts with a lot number whose letter prefix is the
-- sub-label (confirmed by the label appearing in the names for BR/WV/DK/TN/
-- HD/US/AS/SM/FL/MO). Unknown prefixes fall back to "Toyo Enterprise".
INSERT INTO _brand_fix
SELECT c.id, coalesce(m.brand, 'Toyo Enterprise')
FROM "ClothingItem" c
LEFT JOIN (VALUES
  ('SS', 'Sun Surf'), ('SC', 'Sugar Cane'), ('TT', 'Tailor Toyo'), ('BR', 'Buzz Rickson''s'),
  ('SH', 'Star of Hollywood'), ('WV', 'Whitesville'), ('SE', 'Style Eyes'),
  ('DK', 'Duke Kahanamoku'), ('MO', 'Moduct'), ('TN', 'Tuf-Nut'), ('HD', 'Headlight'),
  ('US', 'Union Supply'), ('AS', 'Alaska Sleeping Bag Co.'), ('SM', 'Sailor Moku'),
  ('FL', 'Free Land')
) AS m(prefix, brand) ON m.prefix = substring(c.name from 'Lot No\. ?([A-Z]+)[0-9]')
WHERE c.brand = 'Store' AND pg_temp.host(c."sourceUrl") = 'store.toyo-enterprise.co.jp';

-- 2b. Vendor placeholders, retailer/store names, season codes, category words
-- and manufacturer names used as the brand. Scoped by source host so a real
-- brand with the same spelling elsewhere is never touched.
INSERT INTO _brand_fix
SELECT c.id, m.new_brand
FROM "ClothingItem" c
JOIN (VALUES
  ('edmmond.com', 'edmmond.com', 'Edmmond Studios'),
  ('taylorstitch.com', 'None', 'Taylor Stitch'),
  ('hastparis.com', 'VA', 'Hast Paris'), ('hastparis.com', 'CA', 'Hast Paris'),
  ('hastparis.com', 'AJG', 'Hast Paris'), ('hastparis.com', 'hast-2023', 'Hast Paris'),
  ('quoddy.com', 'Quoddy.com', 'Quoddy'), ('quoddy.com', 'QuoddyDC.com', 'Quoddy'),
  ('gilis.com', 'GILI&#039;S', 'GILI''S'),
  ('communityclothing.co.uk', 'Kid''s', 'Community Clothing'),
  ('libertine-libertine.com', 'Jackets', 'Libertine-Libertine'),
  ('libertine-libertine.com', 'Shirting', 'Libertine-Libertine'),
  ('gramicci.com', 'Mens Outerwear', 'Gramicci'), ('gramicci.com', 'Mens Pants', 'Gramicci'),
  ('gramicci.com', 'Mens Tops', 'Gramicci'), ('gramicci.com', 'Unisex Hoodies', 'Gramicci'),
  ('gramicci.com', 'Unisex Outerwear', 'Gramicci'), ('gramicci.com', 'Unisex Pants', 'Gramicci'),
  ('gramicci.com', 'Unisex Tees', 'Gramicci'), ('gramicci.com', 'Unisex Tops', 'Gramicci'),
  ('gramicci.com', 'Womens Skirts', 'Gramicci'), ('gramicci.com', 'Belt Buckles', 'Gramicci'),
  ('gramicci.com', 'Friends & Family', 'Gramicci'),
  ('farafieldclothing.com', 'AW25', 'Far Afield'), ('farafieldclothing.com', 'SS26', 'Far Afield'),
  ('farafieldclothing.com', 'Fundamentals', 'Far Afield'),
  ('farafieldclothing.com', 'Capo Collection', 'Far Afield'),
  ('taigaigari.com', 'My Store', 'Taiga Igari'),
  ('alexcrane.co', 'Alex Crane Store', 'Alex Crane'),
  ('man-tle.com', 'MAN-TLE SHOP', 'MAN-TLE'), ('man-tle.com', 'MAN–TLE', 'MAN-TLE'),
  ('sattalivity.com', 'SATTA - SS24', 'Satta'), ('sattalivity.com', 'SATTA SS25', 'Satta'),
  ('balibaris.com', 'Balibaris EU', 'Balibaris'),
  ('helascaps.com', 'HÉLAS', 'Hélas'), ('helascaps.com', 'Hélas Limited', 'Hélas'),
  ('snowpeak.com', 'Snow Peak Apparel', 'Snow Peak'),
  ('storymfg.com', 'Story mfg. R.T.S.', 'Story mfg.'),
  ('secondlayer.us', 'SECOND/LAYER Inc.', 'SECOND/LAYER'),
  ('secondlayer.us', 'Confezioni Major S.R.L.', 'SECOND/LAYER'),
  ('secondlayer.us', 'G. Quattro S.A.', 'SECOND/LAYER'),
  ('secondlayer.us', 'Tredicinodi S.R.L', 'SECOND/LAYER'),
  ('linksoul.com', 'Good Trust', 'Linksoul'),
  ('linksoul.com', 'J''Jamm Works, International', 'Linksoul'),
  ('linksoul.com', 'Lamb Screen Printing', 'Linksoul'),
  ('linksoul.com', 'STN company / CMT plant', 'Linksoul'),
  ('linksoul.com', 'Un-Available', 'Linksoul'), ('linksoul.com', 'Union Print Co. LP', 'Linksoul'),
  ('railcarfinegoods.com', 'CMP Screen Printing', 'Railcar Fine Goods'),
  ('railcarfinegoods.com', 'Old Screen Printing', 'Railcar Fine Goods'),
  ('railcarfinegoods.com', 'RFG Screen Printing', 'Railcar Fine Goods'),
  ('railcarfinegoods.com', 'RFG Alteration Services', 'Railcar Fine Goods'),
  ('danjohn.com', 'DAN JOHN VOLUME', 'Dan John'), ('danjohn.com', 'Dan Johnpa', 'Dan John'),
  ('danjohn.com', 'Dnj Dynamic', 'Dan John'),
  ('mc2saintbarth.com', 'MC2SB', 'MC2 Saint Barth'),
  ('kieljamespatrick.com', 'Kiel Jame Patrick', 'Kiel James Patrick'),
  ('drakes.com', 'Games Blazer', 'Drakes'),
  ('folkclothing.com', 'Archive 2025', 'Folk'),
  ('southcoast.com', 'South Coast Surf Shops Online', 'South Coast'),
  ('southcoast.com', 'Captain Fin Co.', 'Captain Fin'),
  ('captainfin.com', 'Captain Fin Co.', 'Captain Fin'),
  ('southcoast.com', 'Katin', 'Katin USA'),
  ('shopdartisan.com', 'STUDIO D''ARTISAN ONLINE STORE', 'D’ARTISAN'),
  ('saint-james.com', 'SANT JAMES x Marine nationale', 'SAINT JAMES x Marine Nationale'),
  ('saint-james.com', 'SAINT JAMES x Marine nationale', 'SAINT JAMES x Marine Nationale'),
  ('antonymorato.com', 'Antonymorato', 'Antony Morato'),
  ('cafeducycliste.com', 'Cafe Du Cycliste', 'Café du Cycliste'),
  ('cuissedegrenouille.com', 'forlifeparis', 'Cuisse de Grenouille'),
  -- "'+351" carries a spreadsheet-escape apostrophe; the label is "+351".
  ('plus351.pt', '''+351', '+351'), ('plus351.pt', '351', '+351')
) AS m(host, old_brand, new_brand)
  ON m.old_brand = c.brand AND pg_temp.host(c."sourceUrl") = m.host
ON CONFLICT (id) DO NOTHING;

-- ministryofsupply.com puts the product name in the vendor field
-- ("Men's Atlas Air Tee", "Atlas Crew Sock", …).
INSERT INTO _brand_fix
SELECT id, 'Ministry of Supply' FROM "ClothingItem"
WHERE pg_temp.host("sourceUrl") = 'ministryofsupply.com' AND brand <> 'Ministry of Supply'
ON CONFLICT (id) DO NOTHING;

SELECT c.brand AS old_brand, f.new_brand, count(*) AS rows
FROM _brand_fix f JOIN "ClothingItem" c USING (id)
WHERE c.brand <> f.new_brand
GROUP BY 1, 2 ORDER BY 3 DESC, 1;

UPDATE "ClothingItem" c SET
  metadata = CASE WHEN coalesce(c.metadata ? 'rawBrand', false) THEN c.metadata
                  ELSE coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('rawBrand', c.brand) END,
  brand = f.new_brand
FROM _brand_fix f
WHERE f.id = c.id AND c.brand <> f.new_brand;

-- 2c. Spelling variants: brands equal after case/punctuation/accent folding
-- collapse to the most common spelling — unless that spelling is ALL CAPS or
-- all lower-case and a Mixed-Case variant has at least a third of its rows.
CREATE TEMP TABLE _brand_merge AS
WITH b AS (
  SELECT brand, count(*) AS n, pg_temp.brand_key(brand) AS k,
         (brand <> upper(brand) AND brand <> lower(brand)) AS mixed
  FROM "ClothingItem" GROUP BY brand
), g AS (
  SELECT k, max(n) AS top_n FROM b WHERE k <> '' GROUP BY k HAVING count(*) > 1
), top AS (
  SELECT DISTINCT ON (b.k) b.k, b.brand, b.mixed
  FROM b JOIN g USING (k) ORDER BY b.k, b.n DESC, b.mixed DESC, b.brand
), best_mixed AS (
  SELECT DISTINCT ON (b.k) b.k, b.brand
  FROM b JOIN g USING (k)
  WHERE b.mixed AND b.n * 3 >= g.top_n
  ORDER BY b.k, b.n DESC, b.brand
)
SELECT b.brand AS old_brand,
       CASE WHEN top.mixed THEN top.brand ELSE coalesce(best_mixed.brand, top.brand) END AS new_brand
FROM b JOIN top USING (k) LEFT JOIN best_mixed USING (k);
DELETE FROM _brand_merge WHERE old_brand = new_brand;

SELECT m.old_brand, m.new_brand, count(*) AS rows
FROM _brand_merge m JOIN "ClothingItem" c ON c.brand = m.old_brand
GROUP BY 1, 2 ORDER BY 2, 3 DESC;

UPDATE "ClothingItem" c SET
  metadata = CASE WHEN coalesce(c.metadata ? 'rawBrand', false) THEN c.metadata
                  ELSE coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('rawBrand', c.brand) END,
  brand = m.new_brand
FROM _brand_merge m
WHERE c.brand = m.old_brand;

SELECT count(DISTINCT brand) AS brands_after,
       count(DISTINCT pg_temp.brand_key(brand)) AS brand_keys_after,
       count(*) FILTER (WHERE metadata ? 'rawBrand') AS rows_with_raw_brand
FROM "ClothingItem";

-- ===========================================================================
-- 3. CATEGORIES
-- ===========================================================================
-- Canonical set (19): t-shirts, polos, shirts, tops, knitwear, sweatshirts,
-- outerwear, suits & blazers, trousers, jeans, shorts, dresses & skirts,
-- swimwear, underwear & socks, shoes, bags, hats, accessories, other.
-- Lower-case on purpose: the iOS app tests category == "shoes" and
-- category.contains("hat").
--
-- Rules are regexes over pg_temp.norm() text, lowest prio wins. scope:
--   r = raw category only, n = product name / subcategory only, b = both.
-- Results starting with '~' are GENERIC: the raw category only says "some
-- top" / "some bottom" / "some accessory" (or mixes two families, e.g.
-- "Pantalons et Shorts", "Pulls et Sweats"), so the product name may refine
-- it; with no name signal the generic falls back to its family default.
\echo
\echo ==== 3. categories ====
CREATE TEMP TABLE _rule (prio int, scope char(1), canon text, re text);
INSERT INTO _rule VALUES
-- non-wearables named by the raw category
(5, 'r', 'other', '\m(towels?|asciugaman[oi]|serviettes?|blankets?|candles?|bougies?|incense|books?|magazines?|publications?|stickers?|decals?|surfboards?|shortboards?|longboards?|skateboards?|fins?|leash(es)?|mugs?|cups?|cookware|cutlery|tents?|tarps?|stoves?|lanterns?|tables?|chairs?|grills?|fireplace|gift ?cards?|fragrances?|colognes?|parfums?|home|homeware|kitchen|dining|pets?|animali|coffee|bitters|jerky|posters?|art prints?|patches|magnets?|care|soaps?|coasters?|bottles?|flasks?|cots?|stakes?|poles?|containers?|coolers?|camping|oven|tablewares?|bowls?|plates?|custodie|parts|velcro|sporting goods|culturel|electronics|lighters?|puzzles?)\M'),
(6, 'r', 'other', '^(buttons|goods)$'),
(9, 'n', 'swimwear', '^costume (?!de |da sera)'),
(10, 'b', 'swimwear', '\m(swim\w*|bikinis?|bagno|nuoto|costum[ei] (mare|inter[oi])|slip mare|bain|bade\w+|banador\w*|wetsuits?|springsuits?|boardshorts?|board shorts?|rash ?guards?|rashvests?|surf trunks?|swim trunks?|copricostume|monopezz[oi]|sarongs?|pareos?|one piece)\M'),
(20, 'b', 'underwear & socks', '\m(socks?|chaussettes?|socquettes?|calze|calzini|calcetines|socken|strumpfe?|underwear|unterwasche|unterhosen?|boxers?|boxershorts?|briefs?|calecons?|sous vetements?|ss vetement|intimo|mutande|lingerie|bralettes?|bras?|pyjamas?|pajamas?|pigiam[ai]|nightwear|sleepwear|loungewear|nachtwasche|nuit|legwear|tights|collants?)\M'),
(30, 'b', 'dresses & skirts', '\m(dress(es)?(?! (shirts?|pants?|trousers?|socks?|shoes?|boots?|belts?|watch(es)?|sneakers?|codes?))|skirts?|skorts?|\w*kleid(er)?|(jeans|mini|midi|maxi|strick|falten|wickel)rock|jupes?|abit[io]|vestit[io]|vestidos?|gonn[ae]|faldas?|jumpsuits?|combinaisons?|playsuits?|rompers?|gowns?|kaftans?|caftans?|tunics?|tuniques?)\M'),
(31, 'r', 'dresses & skirts', '\m(rocke?|robes?)\M'),
(32, 'n', 'dresses & skirts', '^(robe|rock) '),
(40, 'b', 'suits & blazers', '\m(blazers?|suits?(?! (trousers?|pants?|shorts?))|suiting|tailoring|tailored jackets?|sport ?coats?|sports? jackets?|tuxedos?|smokings?|waistcoats?|anzuge?|sakkos?|trajes?|dinner jackets?)\M'),
(41, 'r', 'suits & blazers', '\m(costumes?|americanas?)\M'),
(50, 'b', 'outerwear', '\m(jackets?|coats?|outerwear|parkas?|blousons?|vestes?|manteaux?|\w*jacken?|\w*mantel|giacc(a|he|one|oni)|giubbott[oi]|giubbin[oi]|cappott[oi]|piumin[oi]|chaquetas?|abrigos?|puffers?|anoraks?|windbreakers?|bombers?|raincoats?|trench\w*|doudounes?|impermeables?|cabans?|dufflecoat|kabig|cires?|polaires?|softshell|shackets?|capispalla|cazadoras?|ponchos?|peacoats?|overcoats?|macs?|k ?way)\M'),
(51, 'r', 'outerwear', '\m(outer)\M'),
(59, 'r', '~bottoms', '\m(pantalons (et )?shorts|trousers shorts|pants shorts)\M'),
(60, 'b', 'shorts', '\m(shorts|\w+shorts|bermudas?|pantaloncini|pantaloni corti|walkshorts?)\M'),
(61, 'r', 'shorts', '\mshort\M(?! (sleeves?|sleeved|manches))'),
(62, 'n', 'shorts', '^short (?!(sleeves?|sleeved|manches))'),
(70, 'b', 'jeans', '\m(jeans?|5 pockets?|five pockets?)\M'),
(80, 'b', 'trousers', '\m(pants?|trousers?|pantalons?|pantalon[ei]|pantalones|\w*hosen?|chinos?|cargos?|joggers?|jogging|sweatpants?|trackpants?|leggings?|slacks|corduroys|dungarees|overalls?|salopettes?|culottes?)\M'),
(85, 'r', '~tops', '\m(jersey shirts|shirts tops|t shirts (et )?polos|polos (et )?t shirts|magliett[ae])\M'),
(86, 'r', '~knit', '^knits$|\mtops knits\M|\m(pulls|mailles) et sweat\w*'),
(87, 'r', '~sweats', '^sweats$'),
(90, 'b', 't-shirts', '\m(t ?shirts?|tees?|tee ?shirts?|camisetas?)\M'),
(91, 'n', 't-shirts', '\m(magliett[ae])\M'),
(95, 'b', 'polos', '\m(polos?|\w*poloshirts?)\M'),
(100, 'b', 'sweatshirts', '\m(sweatshirts?|sweat shirts?|sweats?|hoodies?|hoody|hood|felp[ae]|sudaderas?|kapuzen\w+|loopback|quarter ?zips?|half ?zips?|tracksuits?)\M'),
(110, 'b', 'knitwear', '\m(sweaters?|jumpers?|\w*pullovers?|pull(?! on)|pulls|cardigans?|strickjacken?|maglion[ei]|maglieria|tricots?|sueters?|pullis?|pullunder|turtlenecks?|rollnecks?|roll necks?)\M'),
(111, 'r', 'knitwear', '\m(knits?|knitwear|strick\w*|mailles?|maglie?)\M'),
(115, 'b', 'outerwear', '\m(gilets?|vests?|westen?|chalecos?|bodywarmers?|smanicat[oi])\M'),
(120, 'b', 'shirts', '\m(shirts?|chemises?|chemisettes?|\w*hemd(en)?|camic(ia|ie|ette?)|camisas?|\w*blusen?|blouses?|wovens?|button ?(downs?|ups?)|buttondowns?|flannels?|overshirts?|surchemises?|shirting|guayaberas?)\M'),
(130, 'b', '~tops', '\m(tops?(?! handle)|tanks?|debardeurs?|canott(a|e|iera|iere)|singlets?|oberteile?|hauts?|bodys?|bodysuits?|longsleeves?|long sleeves?|langarm|henleys?|rugby|rugbys|rugbies|marinieres?|camis?|camisoles?|jerseys?|superiore)\M'),
(140, 'b', 'shoes', '\m(shoes?|footwear|sneakers?|trainers?|boots?(?! ?cut)|loafers?|sandals?|chaussures?|scarp[ae]|\w*schuhe?|zapat\w+|stiefel\w*|espadrill\w*|slippers?|pantofole|mocassin\w*|moccasins?|derb(y|ys|ies)|mules?|clogs?|flip ?flops?|tongs|stival[ei]|sandali|ciabatte|botas|bott(es|ines?)|chukkas?|brogues?|closed toe|open toe|plimsolls?)\M'),
(141, 'r', 'shoes', '\m(baskets?|oxfords?|slides?)\M'),
(150, 'b', 'bags', '\m(bags?|totes?|backpacks?|rucksacks?|bors[ae]|borsett[ae]|borson[ei]|sacs?|\w*taschen?|bolsos?|mochilas?|pochettes?|pouch(es)?|luggage|duffe?ls?|zain[io]|bagagerie|clutch|handbags?|holdalls?|weekenders?|briefcases?|satchels?|crossbody|cabas|trousses?|shopper)\M'),
(160, 'b', 'hats', '\m(hats?|caps?|beanies?|headwear|berrett[oi]|cappell(o|i|ino|ini)|chapeaux?|casquettes?|bonnets?|\w*mutzen?|hute?|gorr[ao]s?|sombreros?|bobs?|buckets?|balaclavas?|snapbacks?|truckers?|visors?|fedoras?|berets?|headbands?)\M'),
(170, 'b', 'accessories', '\m(belts?|ceintures?|cintur[ae]|cinturones?|gurtel|ties?(?! dye)|neckties?|bow ?ties?|cravat\w*|scarves|scarfs?|echarpes?|sciarp[ae]|schals?|foulards?|shawls?|gloves?|mittens?|gants|guanti|handschuhe|sunglasses|eyewear|glasses|lunettes|occhiali|jewel\w*|bijoux|gioielli|schmuck|watch(es)?|wallets?|portafogli\w*|portefeuilles?|portamonete|card ?holders?|porte cartes?|keychains?|key ?rings?|portachiavi|pocket squares?|handkerchiefs?|fazzolett\w+|bandanas?|bretelles|suspenders|braces|bracelets?|bracciali|necklaces?|rings?|earrings?|cufflinks?|umbrellas?|lanyards?)\M'),
(171, 'r', 'accessories', '\m(maroquinerie|cuir|cheveux|hair)\M'),
-- weak / generic signals
(200, 'r', 'underwear & socks', '\m(slips?)\M'),
(210, 'r', 'jeans', '\m(denims?)\M'),
(220, 'n', 'knitwear', '\m(knit|knits|knitted|knitwear|strick\w*|cashmere)\M'),
(230, 'b', 'sweatshirts', '\m(fleeces?|crewnecks?|crew)\M'),
(300, 'r', '~bottoms', '\m(bottoms?|bas)\M'),
(310, 'r', '~acc', '\m(accessor\w*|accessoires?|acc|chaussant)\M'),
-- non-wearables recognisable from the product name alone (after every garment rule)
(900, 'n', 'other', '\m(candles?|incense|books?|stickers?|surfboards?|mugs?|blankets?|towels?|gift ?cards?|posters?|colognes?|air fresheners?|coasters?)\M');

CREATE FUNCTION pg_temp.canon_cat(txt text, sc char) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT canon FROM _rule
  WHERE scope IN ('b', sc) AND txt <> '' AND txt ~ re
  ORDER BY prio LIMIT 1
$$;

CREATE TEMP TABLE _canon (name text PRIMARY KEY, product_type text);
INSERT INTO _canon VALUES
  ('t-shirts', 'tops'), ('polos', 'tops'), ('shirts', 'tops'), ('tops', 'tops'),
  ('knitwear', 'tops'), ('sweatshirts', 'tops'),
  ('outerwear', 'jackets'), ('suits & blazers', 'jackets'),
  ('trousers', 'bottoms'), ('jeans', 'bottoms'), ('shorts', 'bottoms'),
  -- mixed families: no single productType, so productType is never derived
  ('dresses & skirts', NULL), ('swimwear', NULL), ('underwear & socks', NULL),
  ('shoes', 'accessories'), ('hats', 'accessories'), ('accessories', 'accessories'),
  ('bags', 'bags'), ('other', NULL);

-- The raw value is the stored rawCategory once a row has been canonicalised;
-- a row whose category is NOT canonical (fresh from the crawler) uses category.
CREATE TEMP TABLE _cat AS
SELECT id, raw, raw_n,
       CASE WHEN raw_n ~ '\m(accessor\w*|accessoires?)\M'
            THEN -- "Accessories - Socks": only the accessory family may match
                 CASE WHEN raw_n ~ '\m(apparel|clothing|vetements?|abbigliamento|prendas)\M' THEN NULL
                      WHEN pg_temp.canon_cat(raw_n, 'r') IN ('underwear & socks', 'shoes', 'bags', 'hats', 'accessories', 'other')
                      THEN pg_temp.canon_cat(raw_n, 'r')
                      ELSE '~acc' END
            -- the crawler's own coarse lower-case bucket, not a shop category
            WHEN raw = 'outerwear' THEN '~outer'
            ELSE pg_temp.canon_cat(raw_n, 'r') END AS c_raw,
       -- the brand is removed from the name first ("Rowing Blazers Sweater")
       pg_temp.canon_cat(trim(replace(' ' || pg_temp.norm(name) || ' ', ' ' || pg_temp.norm(brand) || ' ', ' ')), 'n') AS c_name,
       pg_temp.canon_cat(pg_temp.norm(subcategory), 'n') AS c_sub,
       "productType" AS pt
FROM (
  SELECT c.*, r.raw, pg_temp.norm(r.raw) AS raw_n
  FROM "ClothingItem" c
  CROSS JOIN LATERAL (
    SELECT CASE WHEN c.category IN (SELECT name FROM _canon) AND coalesce(c.metadata ? 'rawCategory', false)
                THEN c.metadata->>'rawCategory' ELSE c.category END AS raw
  ) r
) s;

ALTER TABLE _cat ADD COLUMN final text;
UPDATE _cat SET final = CASE
  -- specific raw category wins
  WHEN c_raw IS NOT NULL AND c_raw NOT LIKE '~%' THEN c_raw
  -- generic accessory: the name may only refine inside the accessory family
  WHEN c_raw = '~acc' THEN
    CASE WHEN c_name IN ('underwear & socks', 'shoes', 'bags', 'hats', 'accessories', 'other') THEN c_name
         WHEN c_sub IN ('underwear & socks', 'shoes', 'bags', 'hats', 'accessories') THEN c_sub
         ELSE 'accessories' END
  -- generic or useless raw ("tops", "MENS", "null", "Sale", season codes…):
  -- product name, then the crawler's subcategory, then the generic family,
  -- then the crawler's productType
  WHEN c_name IS NOT NULL AND c_name NOT LIKE '~%' THEN c_name
  WHEN c_sub IS NOT NULL AND c_sub NOT LIKE '~%' THEN c_sub
  WHEN c_raw = '~outer' THEN 'outerwear'
  WHEN c_raw = '~knit' THEN 'knitwear'
  WHEN c_raw = '~sweats' THEN 'sweatshirts'
  WHEN '~tops' IN (c_raw, c_name, c_sub) THEN 'tops'
  WHEN c_raw = '~bottoms' THEN 'trousers'
  WHEN pt = 'tops' THEN 'tops'
  WHEN pt = 'bottoms' THEN 'trousers'
  WHEN pt = 'jackets' THEN 'outerwear'
  WHEN pt = 'bags' THEN 'bags'
  WHEN pt = 'accessories' THEN 'accessories'
  ELSE 'other' END;

SELECT count(*) AS rows_category_changes
FROM _cat t JOIN "ClothingItem" c USING (id) WHERE c.category IS DISTINCT FROM t.final;

UPDATE "ClothingItem" c SET
  metadata = CASE WHEN coalesce(c.metadata ? 'rawCategory', false) THEN c.metadata
                  ELSE coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('rawCategory', c.category) END,
  category = t.final
FROM _cat t
WHERE t.id = c.id
  AND (c.category IS DISTINCT FROM t.final OR NOT coalesce(c.metadata ? 'rawCategory', false));

-- productType (feed "Type" filter: tops | bottoms | jackets | bags |
-- accessories | other) was assigned by the crawler's classifier from more
-- signals than the category, so a concrete value is kept. Only NULL and the
-- catch-all 'other' are derived from the canonical category, and only when the
-- category maps to exactly one productType.
SELECT c."productType" AS old_type, k.product_type AS new_type, count(*) AS rows
FROM "ClothingItem" c JOIN _canon k ON k.name = c.category
WHERE k.product_type IS NOT NULL AND coalesce(c."productType", 'other') = 'other'
GROUP BY 1, 2 ORDER BY 3 DESC;

UPDATE "ClothingItem" c SET
  metadata = CASE WHEN c.metadata ? 'rawProductType' THEN c.metadata
                  ELSE c.metadata || jsonb_build_object('rawProductType', c."productType") END,
  "productType" = k.product_type
FROM _canon k
WHERE k.name = c.category AND k.product_type IS NOT NULL
  AND coalesce(c."productType", 'other') = 'other';

SELECT category, count(*) AS rows, round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM "ClothingItem" GROUP BY 1 ORDER BY 2 DESC;
SELECT count(DISTINCT category) AS categories_after,
       count(*) FILTER (WHERE category = 'other') AS rows_other,
       count(*) FILTER (WHERE category = 'other' AND "isClothing" IS FALSE) AS rows_other_non_clothing
FROM "ClothingItem";

-- ===========================================================================
-- 4. GENDER
-- ===========================================================================
-- The feed's gender filter (parseGender / profileGenderToFilter + the iOS
-- default) asks for [male, unisex] or [female, unisex], so "unisex" rows show
-- for everyone and NULL rows show for no one once a filter is on. Moving a
-- row from unisex to male/female therefore only REMOVES it from the other
-- gender's feed — so we do it only on explicit, one-sided evidence.
--
-- Evidence (word-boundary matched on normalised text, so "women" never
-- matches "men"): URL path, raw category, raw brand/vendor, product name, and
-- a few unambiguous description phrases ("da uomo", "pour femme", "mens
-- sizing"…). Conflicting evidence (men's + women's, adult + kids), or an
-- explicit "unisex", leaves the row alone. A bare /man/ or /woman/ only counts
-- as a whole URL path segment. Bare "man"/"woman"/"lady"/"boys"/"girls"/"baby" are not used
-- in names (Chainsaw Man, Lady White Co., Beastie Boys, baby alpaca…).
\echo
\echo ==== 4. gender ====
UPDATE "ClothingItem" SET
  metadata = CASE WHEN coalesce(metadata ? 'rawGender', false) THEN metadata
                  ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('rawGender', gender) END,
  gender = CASE gender WHEN 'men' THEN 'male' ELSE 'female' END
WHERE gender IN ('men', 'women');

CREATE TEMP TABLE _g AS
SELECT id, gender,
       concat_ws(' | ',
         replace(pg_temp.norm(pg_temp.url_path("sourceUrl")), 'comme des garcons', ''),
         pg_temp.norm(coalesce(metadata->>'rawCategory', category)),
         pg_temp.norm(metadata->>'rawBrand'),
         replace(pg_temp.norm(name), 'comme des garcons', '')) AS t,
       lower(pg_temp.url_path("sourceUrl")) AS u,
       pg_temp.norm(left(description, 4000)) AS d
FROM "ClothingItem"
WHERE gender = 'unisex' OR gender IS NULL;

ALTER TABLE _g ADD COLUMN m boolean, ADD COLUMN f boolean, ADD COLUMN k boolean, ADD COLUMN x boolean;
UPDATE _g SET
  m = t ~ '\m(men|mens|homme|hommes|herren|uomo|hombre|hombres|menswear)\M'
      OR u ~ '/(man|uomo)(/|$)'
      OR d ~ '\m(da uomo|per uomo|pour hommes?|fur herren|para hombres?)\M'
      OR d ~ '\m(mens (sizing|fit|model|sizes?|classic fit)|(this|a|the|our) mens)\M',
  f = t ~ '\m(women|womens|wmns?|femme|femmes|damen|donna|mujer|mujeres|ladies|womenswear)\M'
      OR u ~ '/(woman|donna)(/|$)'
      OR d ~ '\m(da donna|per donna|pour femmes?|fur damen|para mujer(es)?)\M'
      OR d ~ '\m(womens (sizing|fit|model|sizes?)|(this|a|the|our) womens)\M',
  k = t ~ '\m(kids|enfants?|bambin[oiae]|kinder|junior|juniors|toddlers?|youth|garcons?|fillettes?|childrens?)\M'
      OR d ~ '\m(da bambin[oa]|per bambin[oia]|pour enfants?|for kids|fur kinder)\M',
  x = t ~ '\m(unisex|unisexe|mixte)\M';

CREATE TEMP TABLE _g_fix AS
SELECT id, CASE WHEN k THEN 'kids' WHEN m THEN 'male' ELSE 'female' END AS new_gender
FROM _g
WHERE NOT x AND ((k AND NOT m AND NOT f) OR (m AND NOT f AND NOT k) OR (f AND NOT m AND NOT k));

SELECT coalesce(g.gender, '(null)') AS old_gender, f.new_gender, count(*) AS rows
FROM _g_fix f JOIN _g g USING (id) GROUP BY 1, 2 ORDER BY 3 DESC;

UPDATE "ClothingItem" c SET
  metadata = CASE WHEN coalesce(c.metadata ? 'rawGender', false) THEN c.metadata
                  ELSE coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('rawGender', c.gender) END,
  gender = f.new_gender
FROM _g_fix f WHERE f.id = c.id;

-- Rows with no gender at all are invisible in every gendered feed; with no
-- evidence either way they become "unisex" (the catalog's own default).
UPDATE "ClothingItem" SET
  metadata = CASE WHEN coalesce(metadata ? 'rawGender', false) THEN metadata
                  ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('rawGender', NULL) END,
  gender = 'unisex'
WHERE gender IS NULL;

SELECT coalesce(gender, '(null)') AS gender, count(*) FROM "ClothingItem" GROUP BY 1 ORDER BY 2 DESC;

-- ===========================================================================
-- 5. TRUE DUPLICATES
-- ===========================================================================
-- "Same product twice" = same sourceUrl AND one of
--   (a) same primary imageUrl,
--   (b) same normalised name + same ORIGINAL image file (the stored imageUrl
--       is a per-row mirror path, so the source file name is compared),
--   (c) same normalised name + same externalId up to its trailing size token
--       (IH-634S-B/28 vs IH-634S-B/29 = one product crawled per size).
-- Same URL with a different colour in the externalId / a different photo is a
-- colour variant sharing one product page and is left alone, as are rows that
-- only share (brand, name) or share an image across different URLs.
-- A row referenced by a swipe, collection or message is NEVER deactivated;
-- otherwise the newest row of the group survives. Nothing is deleted.
\echo
\echo ==== 5. duplicates ====
CREATE FUNCTION pg_temp.first_img(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(j)
    WHEN 'string' THEN j #>> '{}'
    WHEN 'array' THEN CASE jsonb_typeof(j->0)
      WHEN 'string' THEN j->>0
      WHEN 'object' THEN coalesce(j->0->>'src', j->0->>'url', j->0->>'contentUrl') END
    WHEN 'object' THEN coalesce(j->>'src', j->>'url', j->>'contentUrl') END
$$;
CREATE FUNCTION pg_temp.img_key(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(lower(regexp_replace(regexp_replace(regexp_replace(u, '[?#].*$', ''), '^.*/', ''),
    '(_\d+x\d*|_\d*x\d+|_(small|medium|large|grande|master|compact))?(\.[a-zA-Z0-9]+)?$', '')), '')
$$;

SELECT count(*) AS brand_name_groups_before
FROM (SELECT 1 FROM "ClothingItem" WHERE active GROUP BY brand, name HAVING count(*) > 1) x;

CREATE TEMP TABLE _d AS
SELECT c.id, c."sourceUrl" AS u, c."imageUrl" AS img, pg_temp.norm(c.name) AS nm,
       pg_temp.img_key(coalesce(pg_temp.first_img(c.metadata->'sourceImages'),
                                pg_temp.first_img(c.metadata->'image'))) AS ik,
       nullif(regexp_replace(c."externalId", '[/_ -][A-Za-z0-9.]+$', ''), '') AS xid,
       c."createdAt" AS created,
       (EXISTS (SELECT 1 FROM "Swipe" s WHERE s."itemId" = c.id)
        OR EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."itemId" = c.id)
        OR EXISTS (SELECT 1 FROM "Message" m WHERE m."itemId" = c.id)) AS referenced,
       NULL::text AS dup_of
FROM "ClothingItem" c
WHERE c.active AND c."sourceUrl" IS NOT NULL AND c."sourceUrl" <> '';

-- one pass per rule; rows already marked are out of the later passes
UPDATE _d d SET dup_of = k.keeper FROM (
  SELECT id, first_value(id) OVER w AS keeper FROM _d
  WINDOW w AS (PARTITION BY u, img ORDER BY referenced DESC, created DESC, id)
) k WHERE k.id = d.id AND k.keeper <> d.id AND NOT d.referenced;

UPDATE _d d SET dup_of = k.keeper FROM (
  SELECT id, first_value(id) OVER w AS keeper FROM _d WHERE dup_of IS NULL AND ik IS NOT NULL
  WINDOW w AS (PARTITION BY u, nm, ik ORDER BY referenced DESC, created DESC, id)
) k WHERE k.id = d.id AND k.keeper <> d.id AND NOT d.referenced;

UPDATE _d d SET dup_of = k.keeper FROM (
  SELECT id, first_value(id) OVER w AS keeper FROM _d WHERE dup_of IS NULL AND xid IS NOT NULL
  WINDOW w AS (PARTITION BY u, nm, xid ORDER BY referenced DESC, created DESC, id)
) k WHERE k.id = d.id AND k.keeper <> d.id AND NOT d.referenced;

-- a keeper chosen in an early pass can itself lose a later pass: point every
-- duplicate at the row that finally survives (chains are at most 3 long)
UPDATE _d d SET dup_of = p.dup_of FROM _d p WHERE p.id = d.dup_of AND p.dup_of IS NOT NULL;
UPDATE _d d SET dup_of = p.dup_of FROM _d p WHERE p.id = d.dup_of AND p.dup_of IS NOT NULL;

SELECT count(*) AS rows_to_deactivate, count(DISTINCT dup_of) AS kept_products
FROM _d WHERE dup_of IS NOT NULL;

UPDATE "ClothingItem" c SET
  active = false,
  metadata = coalesce(c.metadata, '{}'::jsonb)
    || jsonb_build_object('duplicateOf', d.dup_of, 'deactivatedBy', 'cleanup-catalog')
FROM _d d WHERE d.id = c.id AND d.dup_of IS NOT NULL;

-- same repair for rows deactivated by an earlier run of this script
UPDATE "ClothingItem" c SET metadata = c.metadata || jsonb_build_object('duplicateOf', k.metadata->>'duplicateOf')
FROM "ClothingItem" k
WHERE k.id = c.metadata->>'duplicateOf' AND NOT k.active AND k.metadata ? 'duplicateOf';

SELECT count(*) FILTER (WHERE NOT active) AS inactive_rows,
       count(*) FILTER (WHERE metadata->>'deactivatedBy' = 'cleanup-catalog') AS deactivated_by_cleanup
FROM "ClothingItem";
SELECT count(*) AS brand_name_groups_left_alone
FROM (SELECT 1 FROM "ClothingItem" WHERE active GROUP BY brand, name HAVING count(*) > 1) x;
SELECT count(*) AS same_url_groups_left_alone
FROM (SELECT 1 FROM "ClothingItem" WHERE active AND "sourceUrl" IS NOT NULL GROUP BY "sourceUrl" HAVING count(*) > 1) x;
SELECT count(*) AS same_brand_image_groups_left_alone
FROM (SELECT 1 FROM "ClothingItem" WHERE active GROUP BY brand, "imageUrl" HAVING count(*) > 1) x;

-- ===========================================================================
\echo
\echo ==== AFTER ====
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE active) AS active_rows,
       count(*) FILTER (WHERE price > 5000) AS price_over_5000,
       max(price) AS max_price,
       count(DISTINCT brand) AS brands,
       count(DISTINCT category) AS categories
FROM "ClothingItem";
SELECT coalesce("productType", '(null)') AS "productType", count(*) FROM "ClothingItem" GROUP BY 1 ORDER BY 2 DESC;

\if :{?dry_run}
  \echo dry_run set: ROLLBACK
  ROLLBACK;
\else
  COMMIT;
  \echo committed
\endif
