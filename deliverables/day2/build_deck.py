"""Build the Day 2 deck: deliverables/day2/Team Maze - Al Ain University.pptx (six slides, readable with no sound).

    python deliverables\\day2\\build_deck.py          (needs python-pptx and Pillow)

One message per slide, big numbers and pictures, very few words. Every word is in CONTENT below. The pictures come
from deliverables/day2/screens (made by capture.py). If deliverables/day2/demo.mp4 exists it is embedded on slide 3.
The look follows the dashboard: off-white page, ink text, red only for failures, blue only for the main thing, and
the dark panel of the hologram for the opening slide.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

HERE = Path(__file__).resolve().parent
SCREENS = HERE / "screens"
VIDEO = HERE / "demo.mp4"
OUT = HERE / "Team Maze - Al Ain University.pptx"

# ---------------------------------------------------------------------------- every word on the slides
FOOTER = "AcuMain · Team Maze, Al Ain University"
CONTENT = {
    1: {
        "kicker": "CASE 1 · BOEING 787 NOSE LANDING GEAR ACTUATOR",
        "headline": "Which aircraft get this week's hangar slots?",
        "sub": "A team of AI agents turns failure predictions into the week's repair list. The planner approves every action.",
        "rows": [
            ("USER", "Fleet maintenance planning manager"),
            ("PROBLEM", "Actuators fail with no warning: surprise groundings"),
            ("DECISION", "Which actuators to repair this week, and in what order"),
        ],
        "stats": [
            ("184", "surprise failures in 100 weeks on 100 aircraft", "red"),
            ("5 weeks", "of warning before a failure", "ink"),
            ("91%", "of failures become planned repairs", "blue"),
        ],
        "panel_label": "INSIDE THE DASHBOARD",
        "panel_caption": "Each aircraft's actuator, drawn from its own readings.",
        "team": "Team Maze, Al Ain University: Mohammad Umar, Farooq Shafeek, Abdulahad, Sadiq, Zubair",
    },
    2: {
        "kicker": "ARCHITECTURE",
        "headline": "Four agents. One trained model. You approve.",
        "nodes": {
            "planner": ("Planner", "Brings in the records"),
            "dashboard": ("Dashboard", "FastAPI, one Docker image"),
            "lead": ("Orchestrator", "Claude Sonnet 5.5 hands out the work"),
            "approve": ("Planner approves", "Work orders: SIMULATED"),
            "risk": ("1  Risk agent", "check_records · run_failure_model\nlist_records · propose_actions"),
            "stock": ("2  Stock agent", "check_stock · reserve_parts"),
            "supply": ("3  Supply agent", "get_supply_options\nrequest_parts"),
            "model": ("Failure model", "Our Stage 2 model with its fitted preprocessing"),
            "store": ("Hangar store", "SIMULATED"),
            "depot": ("Supply department", "SIMULATED"),
        },
        "pills": ["Every step is logged", "No API key? A built-in planner runs the same tools", "Model fails: nothing is invented"],
    },
    3: {
        "kicker": "WORKFLOW",
        "headline": "Watch it work",
        "sub": "2 minutes. Click to play. Captions on screen, so no sound is needed.",
        "steps": ["Bring in the records", "The agents review them", "See the list and the actuator", "You approve or reject"],
        "placeholder_caption": "Demo video goes here: Insert > Video > This device",
    },
    4: {
        "kicker": "VALIDATION",
        "headline": "It warns early. It never guesses.",
        "figures": [
            ("185 of 187", "failures flagged ahead, on aircraft the model never saw", "blue"),
            ("5 weeks", "typical warning before a failure", "ink"),
            ("0.709", "F1 on unseen aircraft (our validation)", "ink"),
            ("110", "automated tests, every failure path", "ink"),
        ],
        "missing": ("MISSING INPUT", "Readings blank: no prediction, a repeat test."),
        "outage": ("TOOL FAILURE", "Model down: the review stops. Try again."),
        "note": "Model: logistic regression with gradient-boosted trees, on each reading divided by its test's reference settings, trained on the 10,000 Stage 2 records. "
                "The official Stage 2 score is the organisers', from our submitted test predictions.",
    },
    5: {
        "kicker": "BUSINESS VALUE",
        "headline": "From 184 surprise groundings to 17.",
        "sub": "Same fleet. Same 2 hangar slots a week.",
        "before": ("TODAY", "184 surprises"),
        "after": ("WITH ACUMAIN", "167 planned", "17 surprises"),
        "legend": "Each square is one actuator failure. Success is measured by how many turn blue.",
        "tiles": [
            ("91%", "PROJECTED", "of failures become planned repairs", "blue"),
            ("65 to 79%", "PROJECTED", "with the same slots, oldest actuators first", "grey"),
            ("5 weeks", "DEMONSTRATED", "of warning. A spare part takes 14 days", "ink"),
            ("40 s", "DEMONSTRATED", "to review 2,000 records", "ink"),
        ],
        "note": "Projected: a replay of the 100 training aircraft over 100 weeks, not a trial. In money: surprises avoided x (cost of a surprise grounding minus cost of a planned repair), with GAL's cost figures.",
    },
    6: {
        "kicker": "LIMITS AND NEXT STEPS",
        "headline": "Honest limits. Clear next steps.",
        "limits_title": "LIMITS",
        "limits": [
            "One record per aircraft, no history",
            "Synthetic hackathon data",
            "Stock, supply and work orders are simulated",
            "A planning aid: a person approves every action",
        ],
        "next_title": "NEXT",
        "next": [
            ("Use actuator history", "F1 0.71 to 0.77 in our tests"),
            ("Connect real systems", "Stock, supply, maintenance"),
            ("Add GAL's costs", "Value in money"),
        ],
        "run_title": "RUN IT",
        "command": "docker compose up --build",
        "address": "http://localhost:8787",
        "run_notes": ["Works with no API key", "Public replay: acumain.vercel.app"],
    },
}

# ---------------------------------------------------------------------------- the dashboard's look
BG, INK, INK2, INK3 = RGBColor(0xFA, 0xFA, 0xF7), RGBColor(0x16, 0x17, 0x1B), RGBColor(0x49, 0x4C, 0x54), RGBColor(0x80, 0x83, 0x8B)
LINE, LINE2, WHITE = RGBColor(0xE4, 0xE3, 0xDD), RGBColor(0xCD, 0xCC, 0xC5), RGBColor(0xFF, 0xFF, 0xFF)
RED, BLUE, WASH, SUNKEN = RGBColor(0xBD, 0x2E, 0x1A), RGBColor(0x1E, 0x46, 0xC8), RGBColor(0xED, 0xF1, 0xFC), RGBColor(0xF2, 0xF2, 0xED)
DARK, CYAN, MIST, GREY = RGBColor(0x05, 0x14, 0x1C), RGBColor(0x6F, 0xD6, 0xF5), RGBColor(0xC9, 0xD6, 0xDC), RGBColor(0x8A, 0x8D, 0x95)
TONE = {"red": RED, "blue": BLUE, "ink": INK, "grey": GREY}
FONT, HEAD, MONO = "Segoe UI", "Segoe UI Semibold", "Consolas"
W, H = 13.333, 7.5
LEFT, RIGHT = 0.7, 12.633


def box(slide, x, y, w, h, paragraphs, anchor=MSO_ANCHOR.TOP):
    """A text box. `paragraphs` is a list of (text, size, colour, font, extra) where extra may set align, after or spacing."""
    shape = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = shape.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = anchor
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    for i, item in enumerate(paragraphs):
        text, size, colour, font = item[:4]
        extra = item[4] if len(item) > 4 else {}
        p = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        p.alignment = extra.get("align", PP_ALIGN.LEFT)
        p.space_after = Pt(extra.get("after", 0))
        p.line_spacing = extra.get("spacing", 1.05)
        for part, part_colour, part_font in (text if isinstance(text, list) else [(text, colour, font)]):
            run = p.add_run()
            run.text = part
            run.font.size, run.font.name = Pt(size), part_font
            run.font.color.rgb = part_colour
    return shape


def rule(slide, x1, y1, x2, y2, colour=INK, width=1.0, arrow=False):
    line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    style = line._element.find(qn("p:style"))          # the theme's style gives lines a shadow; the dashboard has none
    if style is not None:
        line._element.remove(style)
    line.line.color.rgb = colour
    line.line.width = Pt(width)
    if arrow:
        ln = line.line._get_or_add_ln()
        ln.append(ln.makeelement(qn("a:tailEnd"), {"type": "triangle", "w": "med", "len": "med"}))
    return line


def block(slide, x, y, w, h, fill, outline=None, rounded=0.0):
    """A plain filled rectangle with no shadow."""
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    if rounded:
        shape.adjustments[0] = rounded
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    if outline is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = outline
        shape.line.width = Pt(0.75)
    return shape


def node(slide, x, y, w, h, title, sub, kind="agent"):
    """A box of the diagram, in the style of the dashboard's team screen."""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE if kind in ("model", "system") else MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    if kind not in ("model", "system"):
        shape.adjustments[0] = 0.12
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = WASH if kind == "main" else SUNKEN if kind == "system" else WHITE
    shape.line.color.rgb = BLUE if kind == "main" else INK if kind == "model" else LINE2
    shape.line.width = Pt(1.75 if kind in ("model", "main") else 1)
    if kind == "system":
        shape.line.dash_style = 4            # dashed: this part is simulated
    frame = shape.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.margin_left = frame.margin_right = Inches(0.12)
    frame.margin_top = frame.margin_bottom = Inches(0.04)
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = title
    run.font.size, run.font.name = Pt(15), MONO if kind == "model" else HEAD
    run.font.color.rgb = INK
    for line in sub.split("\n"):
        q = frame.add_paragraph()
        q.alignment = PP_ALIGN.CENTER
        r = q.add_run()
        r.text = line
        mono = "_" in line
        r.font.size, r.font.name = Pt(10.5 if mono else 11.5), MONO if mono else FONT
        r.font.color.rgb = RED if "SIMULATED" in line else INK2
    return shape


def picture(slide, name, x, y, width, top=0.0, bottom=1.0, left=0.0, right=1.0, border=True):
    """A screenshot, cropped to a part of it. Returns its height in inches."""
    path = SCREENS / name
    px, py = Image.open(path).size
    height = width * (py * (bottom - top)) / (px * (right - left))
    pic = slide.shapes.add_picture(str(path), Inches(x), Inches(y))
    pic.crop_left, pic.crop_right, pic.crop_top, pic.crop_bottom = left, 1 - right, top, 1 - bottom
    pic.left, pic.top, pic.width, pic.height = Inches(x), Inches(y), Inches(width), Inches(height)
    if border:
        pic.line.color.rgb = LINE2
        pic.line.width = Pt(0.75)
    return height


def start(prs, number, kicker, headline, sub=None):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = BG
    box(slide, LEFT, 0.5, 8, 0.3, [(kicker, 11, BLUE, HEAD)])
    box(slide, LEFT, 0.8, RIGHT - LEFT, 0.8, [(headline, 34, INK, HEAD)])
    if sub:
        box(slide, LEFT, 1.52, RIGHT - LEFT, 0.4, [(sub, 15, INK2, FONT)])
    box(slide, LEFT, 7.02, 8, 0.3, [(FOOTER, 9.5, INK3, FONT)])
    box(slide, RIGHT - 1, 7.02, 1, 0.3, [(f"{number} / 6", 9.5, INK3, FONT, {"align": PP_ALIGN.RIGHT})])
    return slide


def stat(slide, x, y, w, number, label, colour=INK, size=36, tag=None):
    """A big number with a few words under it."""
    rule(slide, x, y, x + w, y, LINE2, 0.75)
    top = y + 0.1
    if tag:
        box(slide, x, top, w, 0.22, [(tag, 8.5, BLUE if tag == "DEMONSTRATED" else INK3, HEAD)])
        top += 0.22
    high = size / 72 * 1.22
    box(slide, x, top, w, high, [(number, size, colour, HEAD)])
    box(slide, x, top + high + 0.02, w, 0.6, [(label, 11.5, INK2, FONT)])


def pill(slide, x, y, w, text):
    shape = block(slide, x, y, w, 0.44, SUNKEN, LINE2, rounded=0.5)
    frame = shape.text_frame
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.margin_left = frame.margin_right = Inches(0.1)
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.size, run.font.name = Pt(12), FONT
    run.font.color.rgb = INK
    return shape


def waffle(slide, x, y, blue, total=184, columns=23, pitch=0.25, side=0.2):
    """One square per failure: the first `blue` are planned repairs, the rest are surprises."""
    for i in range(total):
        col, row = i % columns, i // columns
        block(slide, x + col * pitch, y + row * pitch, side, side, BLUE if i < blue else RED)
    return columns * pitch, (total // columns) * pitch


def build() -> Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(W), Inches(H)

    # ---- 1. the user, the problem and the decision, with the hologram as the picture
    c = CONTENT[1]
    s = prs.slides.add_slide(prs.slide_layouts[6])
    fill = s.background.fill
    fill.solid()
    fill.fore_color.rgb = BG
    px = 7.75                                                    # the dark panel starts here
    block(s, px, 0, W - px, H, DARK)
    block(s, LEFT, 0.55, 0.42, 0.42, INK, rounded=0.22)          # the dashboard's mark: a gauge needle over its pivot
    u = 0.42 / 32
    rule(s, LEFT + 16 * u, 0.55 + 7 * u, LEFT + 16 * u, 0.55 + 19 * u, WHITE, 1.8)
    rule(s, LEFT + 16 * u, 0.55 + 12 * u, LEFT + 22 * u, 0.55 + 17 * u, WHITE, 1.8)
    pivot = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(LEFT + 12.4 * u), Inches(0.55 + 19.4 * u), Inches(7.2 * u), Inches(7.2 * u))
    pivot.shadow.inherit = False
    pivot.fill.background()
    pivot.line.color.rgb = WHITE
    pivot.line.width = Pt(1.8)
    box(s, LEFT + 0.55, 0.55, 3, 0.42, [("AcuMain", 20, INK, HEAD)], MSO_ANCHOR.MIDDLE)
    box(s, LEFT, 1.32, 6.6, 0.3, [(c["kicker"], 10.5, BLUE, HEAD)])
    box(s, LEFT, 1.62, 6.7, 1.45, [(c["headline"], 38, INK, HEAD, {"spacing": 0.98})])
    box(s, LEFT, 3.12, 6.5, 0.7, [(c["sub"], 15, INK2, FONT, {"spacing": 1.12})])
    y = 4.02
    for label, text in c["rows"]:
        rule(s, LEFT, y, LEFT + 6.5, y, LINE2, 0.75)
        box(s, LEFT, y, 1.25, 0.44, [(label, 9.5, INK3, HEAD)], MSO_ANCHOR.MIDDLE)
        box(s, LEFT + 1.3, y, 5.2, 0.44, [(text, 14, INK, FONT)], MSO_ANCHOR.MIDDLE)
        y += 0.44
    rule(s, LEFT, y, LEFT + 6.5, y, LINE2, 0.75)
    x = LEFT
    for (number, label, tone), sw in zip(c["stats"], (1.85, 2.45, 2.2)):
        box(s, x, 5.52, sw, 0.7, [(number, 34, TONE[tone], HEAD)])
        box(s, x, 6.18, sw - 0.25, 0.5, [(label, 11, INK2, FONT)])
        x += sw
    box(s, LEFT, 7.02, 6.8, 0.3, [(c["team"], 9.5, INK3, FONT)])
    hw = 5.1
    hx = px + (W - px - hw) / 2
    box(s, hx, 1.5, hw, 0.3, [(c["panel_label"], 10.5, CYAN, HEAD)])
    high = picture(s, "hologram.png", hx, 1.9, hw, top=0.025, bottom=0.975, left=0.02, right=0.98, border=False)      # the crop takes the rounded corners off
    box(s, hx, 1.9 + high + 0.24, hw, 0.8, [(c["panel_caption"], 15, MIST, FONT, {"spacing": 1.1})])
    box(s, W - 1.7, 7.02, 1, 0.3, [("1 / 6", 9.5, GREY, FONT, {"align": PP_ALIGN.RIGHT})])

    # ---- 2. architecture
    c = CONTENT[2]
    s = start(prs, 2, c["kicker"], c["headline"])
    n = c["nodes"]
    row1, row2, row3 = 1.95, 3.42, 4.92
    h1, h2, h3 = 0.92, 1.08, 0.9
    node(s, 0.7, row1, 2.0, h1, *n["planner"])
    node(s, 3.15, row1, 2.55, h1, *n["dashboard"])
    node(s, 6.15, row1, 3.4, h1, *n["lead"], kind="main")
    node(s, 10.05, row1, 2.58, h1, *n["approve"])
    for x1, x2 in ((2.7, 3.15), (5.7, 6.15), (9.55, 10.05)):
        rule(s, x1, row1 + h1 / 2, x2, row1 + h1 / 2, INK2, 1.25, arrow=True)
    agents = {"risk": (2.0, 3.7), "stock": (6.35, 3.0), "supply": (9.85, 2.78)}
    systems = {"risk": ("model", "model"), "stock": ("store", "system"), "supply": ("depot", "system")}
    bus = row1 + h1 + 0.25
    rule(s, 7.85, row1 + h1, 7.85, bus, INK2, 1.25)
    rule(s, 3.85, bus, 11.24, bus, INK2, 1.25)
    for key, (x, w) in agents.items():
        mid = x + w / 2
        rule(s, mid, bus, mid, row2, INK2, 1.25, arrow=True)
        node(s, x, row2, w, h2, *n[key])
        rule(s, mid, row2 + h2, mid, row3, INK2, 1.25, arrow=True)
        name, kind = systems[key]
        node(s, x, row3, w, h3, *n[name], kind=kind)
    widths = [2.6, 5.1, 3.35]
    x = LEFT
    gap = (RIGHT - LEFT - sum(widths)) / (len(widths) - 1)
    for text, w in zip(c["pills"], widths):
        pill(s, x, 6.22, w, text)
        x += w + gap

    # ---- 3. workflow: the demo video, large, with the four steps beside it
    c = CONTENT[3]
    s = start(prs, 3, c["kicker"], c["headline"], c["sub"])
    fx, fy, fw = LEFT, 2.05, 8.55
    fh = fw * 9 / 16
    if VIDEO.is_file():
        movie = s.shapes.add_movie(str(VIDEO), Inches(fx), Inches(fy), Inches(fw), Inches(fh), poster_frame_image=str(SCREENS / "team-29.png"), mime_type="video/mp4")
        try:                                                        # a thin border, so the white poster does not melt into the page
            movie.line.color.rgb = LINE2
            movie.line.width = Pt(0.75)
        except Exception:
            pass
    else:
        picture(s, "team-29.png", fx, fy, fw)
        box(s, fx, fy + fh + 0.06, fw, 0.3, [(c["placeholder_caption"], 10.5, BLUE, FONT)])
    sx, y = 9.75, 2.05
    step = fh / len(c["steps"])
    for i, title in enumerate(c["steps"], 1):
        rule(s, sx, y, RIGHT, y, INK if i == 1 else LINE2, 1 if i == 1 else 0.75)
        box(s, sx, y + 0.14, 0.6, 0.8, [(str(i), 34, BLUE, HEAD)])
        box(s, sx + 0.7, y + 0.2, RIGHT - sx - 0.7, 0.9, [(title, 16, INK, HEAD, {"spacing": 1.05})])
        y += step
    rule(s, sx, y, RIGHT, y, LINE2, 0.75)

    # ---- 4. validation, and the two failures it handles
    c = CONTENT[4]
    s = start(prs, 4, c["kicker"], c["headline"])
    gap = 0.3
    fw4 = (RIGHT - LEFT - gap * 3) / 4
    for i, (number, label, tone) in enumerate(c["figures"]):
        stat(s, LEFT + i * (fw4 + gap), 1.78, fw4, number, label, TONE[tone], 34)
    pw = (RIGHT - LEFT - 0.4) / 2
    py = 3.42
    for j, (name, key, crop) in enumerate((("missing.png", "missing", (0.13, 0.80)), ("outage.png", "outage", (0.0, 0.67)))):
        x = LEFT + j * (pw + 0.4)
        high = picture(s, name, x, py, pw, top=crop[0], bottom=crop[1])
        tag, text = c[key]
        box(s, x, py + high + 0.12, pw, 0.34, [([(tag + "   ", RED, HEAD), (text, INK, FONT)], 13, INK, FONT)])
    box(s, LEFT, 6.45, RIGHT - LEFT, 0.45, [(c["note"], 9.5, INK3, FONT)])

    # ---- 5. business value: every failure as a square, today and with AcuMain
    c = CONTENT[5]
    s = start(prs, 5, c["kicker"], c["headline"], c["sub"])
    wy = 2.78
    ax, bx = LEFT, 6.88
    box(s, ax, 2.08, 5.75, 0.26, [(c["before"][0], 10.5, INK3, HEAD)])
    box(s, ax, 2.3, 5.75, 0.44, [(c["before"][1], 20, RED, HEAD)])
    waffle(s, ax, wy, 0)
    box(s, bx, 2.08, 5.75, 0.26, [(c["after"][0], 10.5, BLUE, HEAD)])
    box(s, bx, 2.3, 5.75, 0.44, [([(c["after"][1], BLUE, HEAD), ("   " + c["after"][2], RED, HEAD)], 20, BLUE, HEAD)])
    waffle(s, bx, wy, 167)
    box(s, LEFT, wy + 2.06, RIGHT - LEFT, 0.3, [(c["legend"], 11, INK3, FONT)])
    gap = 0.3
    tw = (RIGHT - LEFT - gap * 3) / 4
    for i, (number, tag, label, tone) in enumerate(c["tiles"]):
        stat(s, LEFT + i * (tw + gap), 5.22, tw, number, label, TONE[tone], 28, tag)
    box(s, LEFT, 6.62, RIGHT - LEFT, 0.36, [(c["note"], 9.5, INK3, FONT)])

    # ---- 6. limits, next steps, and how to run it
    c = CONTENT[6]
    s = start(prs, 6, c["kicker"], c["headline"])
    lw = 4.75
    box(s, LEFT, 1.82, lw, 0.28, [(c["limits_title"], 10.5, INK3, HEAD)])
    y = 2.14
    for text in c["limits"]:
        rule(s, LEFT, y, LEFT + lw, y, LINE2, 0.75)
        block(s, LEFT, y + 0.23, 0.14, 0.14, RED)
        box(s, LEFT + 0.34, y, lw - 0.34, 0.6, [(text, 15, INK, FONT)], MSO_ANCHOR.MIDDLE)
        y += 0.6
    rule(s, LEFT, y, LEFT + lw, y, LINE2, 0.75)
    nx = 5.95
    box(s, nx, 1.82, RIGHT - nx, 0.28, [(c["next_title"], 10.5, BLUE, HEAD)])
    cw = (RIGHT - nx - 0.5) / 3
    for i, (title, text) in enumerate(c["next"]):
        x = nx + i * (cw + 0.25)
        block(s, x, 2.14, cw, 2.4, WHITE, LINE2, rounded=0.06)
        box(s, x + 0.2, 2.24, cw - 0.4, 0.8, [(str(i + 1), 40, BLUE, HEAD)])
        box(s, x + 0.2, 3.08, cw - 0.4, 0.7, [(title, 15, INK, HEAD, {"spacing": 1.05})])
        box(s, x + 0.2, 3.86, cw - 0.4, 0.55, [(text, 11.5, INK2, FONT)])
    by = 5.2
    block(s, LEFT, by, RIGHT - LEFT, 1.35, DARK, rounded=0.08)
    box(s, LEFT + 0.4, by + 0.22, 2, 0.26, [(c["run_title"], 10.5, CYAN, HEAD)])
    box(s, LEFT + 0.4, by + 0.52, 7.4, 0.6, [([(c["command"], WHITE, MONO), ("    " + c["address"], CYAN, MONO)], 20, WHITE, MONO)], MSO_ANCHOR.MIDDLE)
    box(s, RIGHT - 4.3, by + 0.3, 3.9, 0.8, [(c["run_notes"][0], 13, MIST, FONT, {"align": PP_ALIGN.RIGHT, "after": 4}), (c["run_notes"][1], 13, MIST, FONT, {"align": PP_ALIGN.RIGHT})], MSO_ANCHOR.MIDDLE)

    prs.save(OUT)
    return OUT


if __name__ == "__main__":
    out = build()
    print(f"Wrote {out}" + (" (with the demo video)" if VIDEO.is_file() else " (slide 3 has a placeholder for the video)"))
