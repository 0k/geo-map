"""Real system-Chrome acceptance of the demo build.

Serves demo-dist/ in-process, stubs every tile request with a 1x1 PNG
(no network), and asserts the widget's contract in a real engine:
SVG tracks and places are drawn, tiles come only from the chosen free
basemap, no KML-referenced icon is fetched, popups, full screen and
teardown behave.  Exits non-zero on the first failed check.
"""
import base64
import functools
import http.server
import pathlib
import sys
import threading
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def check(condition, message):
    if not condition:
        print(f"FAIL: {message}")
        sys.exit(1)
    print(f"PASS: {message}")


def run():
    handler = functools.partial(Quiet, directory=str(ROOT / "demo-dist"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page(viewport={"width": 900, "height": 900})
                errors, external = [], []
                page.on("pageerror", lambda error: errors.append(str(error)))

                def route(r):
                    host = urlparse(r.request.url).hostname or ""
                    if host == "127.0.0.1":
                        return r.continue_()
                    external.append(r.request.url)
                    return r.fulfill(status=200, content_type="image/png", body=PNG)

                page.route("**/*", route)
                page.goto(f"{origin}/index.html")
                page.evaluate("window.demoReady")
                kmz = page.locator('[data-file="track.kmz"]')
                kmz.locator(".leaflet-tile-loaded").first.wait_for(timeout=5000)

                check(not errors, f"no page errors ({errors})")
                check(kmz.locator(".gm-title-label").inner_text() == "track.kmz", "title shows the host label")
                check(kmz.locator(".gm-summary").inner_text() == "1 track · 2 places", "summary counts tracks and places")
                check(kmz.locator("path.gm-track.gm-styled").count() == 1, "the track is drawn as one SVG path in the file's colour")
                stroke = kmz.locator("path.gm-track").get_attribute("stroke")
                check(stroke == "#ff0000", f"KML LineStyle colour is honoured ({stroke})")
                check(kmz.locator("path.gm-start").count() == 1 and kmz.locator("path.gm-end").count() == 1, "start and end markers are drawn")
                places = page.locator('[data-file="places.kml"] path.gm-place')
                check(places.count() == 2, "Google Maps places are drawn")
                fill = page.evaluate("getComputedStyle(document.querySelector('[data-file=\"places.kml\"] path.gm-place')).fill")
                check(fill == "rgb(47, 127, 224)", f"unstyled places use the theme colour ({fill})")
                check(page.locator('[data-file="shapes.geojson"] path.gm-area').count() == 1, "GeoJSON polygons are drawn as areas")
                missing = page.locator('[data-file="missing.kml"] .gm-status[data-state="error"]')
                check("File request failed: 404" in missing.inner_text(), "a load failure shows its reason")

                hosts = {urlparse(u).hostname for u in external}
                check(hosts == {"tile.openstreetmap.org"}, f"only OSM tiles are requested by default ({hosts})")
                check(not any("gstatic" in u or "google" in u for u in external), "no KML-referenced icon is fetched")
                zooms = {int(urlparse(u).path.split("/")[1]) for u in external}
                check(max(zooms) <= 19, f"no tile beyond OSM's max zoom ({sorted(zooms)})")
                height = kmz.locator(".gm-map").bounding_box()["height"]
                check(abs(height - 360) < 1, f"inline map is 360px tall ({height})")

                # The view is fitted to the track (not the fallback zoom).
                zoom = page.evaluate("window.demoHandles['track.kmz'].leaflet.getZoom()")
                check(14 <= zoom <= 16, f"view is fitted to the track (zoom {zoom})")

                # Popup from the list.
                kmz.locator("details.gm-legend summary").click()
                kmz.locator(".gm-item").nth(1).click()
                popup = kmz.locator(".leaflet-popup-content")
                popup.wait_for(timeout=2000)
                check(popup.locator(".gm-popup-name").inner_text() == "Synthetic Ridge Loop", "list click opens the item popup")
                check(popup.locator(".gm-popup-meta").inner_text().startswith("1.9 km · 1 h 00 · "), "popup shows length and duration")

                # Basemap switch.
                before = len(external)
                kmz.locator("select.gm-basemap").select_option("opentopomap")
                page.wait_for_function(f"document.querySelectorAll('[data-file=\"track.kmz\"] .leaflet-tile-loaded').length > 0")
                page.wait_for_timeout(300)
                new_hosts = {urlparse(u).hostname for u in external[before:]}
                check(new_hosts and all(h.endswith(".tile.opentopomap.org") for h in new_hosts), f"switching basemap fetches OpenTopoMap tiles ({new_hosts})")
                check("OpenTopoMap" in kmz.locator(".leaflet-control-attribution").inner_text(), "attribution follows the basemap")

                # Full screen and back.
                kmz.locator(".gm-fullscreen").click()
                box = page.locator('.gm-portal .gm-root[data-layout="full"] .gm-map').bounding_box()
                check(box and box["width"] > 850 and box["height"] > 700, f"full screen map fills the viewport ({box})")
                page.keyboard.press("Escape")
                check(page.locator(".gm-portal").count() == 0 and kmz.locator(".gm-map").count() == 1, "Escape returns the map in place")

                # Close.
                kmz.locator(".gm-close").click()
                check(kmz.locator(".leaflet-container").count() == 0, "✕ removes the map")
                check(not errors, f"still no page errors ({errors})")
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run()
