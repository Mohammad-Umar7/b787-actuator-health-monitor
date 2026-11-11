"""Build the Day 2 deck: deliverables/day2/Team Maze - Al Ain University.pptx (six slides, readable with no sound).

    python deliverables\\day2\\build_deck.py [output.pptx]          (needs python-pptx and Pillow)

The headings and the content follow the organisers' template (Title, Introduction & Problem, Solution & Features,
Technical Stack & Implementation, Demo & Impact, Thank You, with its section labels), but the design is the
dashboard's own: off-white page, ink text, red only for failures, blue only for the main thing, and the dark panel
of the hologram. One message per slide, big numbers and pictures, very few words. Every word is in CONTENT below.
The team and the student numbers are read from team.json next to this file. The pictures come from
deliverables/day2/screens (made by capture.py). The demo video (demo.mp4) is embedded on slide 5.
"""
from __future__ import annotations

import json
import sys
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
TEAM_FILE = HERE / "team.json"
TEAM = json.loads(TEAM_FILE.read_text(encoding="utf-8")) if TEAM_FILE.is_file() else {"university": "Al Ain University", "team": "Team Maze", "students": []}

# ---------------------------------------------------------------------------- every word on the slides
FOOTER = f"AcuMain · {TEAM['team']}, {TEAM['university']}"
CONTENT = {
    1: {
        "kicker": "AI FOR SMART MAINTENANCE · SOLUTION SUBMISSION",
        "title": ("Acu", "Main"),
        "tagline": "Which aircraft get this week's hangar slots?",
        "rows": [("TEAM", TEAM["team"]), ("UNIVERSITY", TEAM["university"]), ("CASE", "Case 1: Boeing 787 nose landing gear actuator")],
        "students_label": "STUDENTS",
        "panel_label": "INSIDE THE DASHBOARD",
        "panel_caption": "Each aircraft's actuator, drawn from its own readings.",
    },
    2: {
        "kicker": "SOLUTION SUBMISSION · 1 / 4",
        "headline": ("Introduction & ", "Problem"),
        "project_label": "PROJECT NAME",
        "project": "AcuMain",
        "team_label": "TEAM MEMBERS",
        "case_label": "CASE CHOSEN",
        "case": ("Case 1", "Boeing 787 nose landing gear actuator"),
        "challenge_label": "THE CHALLENGE YOU TACKLE",
        "challenge": "Which aircraft get this week's hangar slots?",
        "challenge_sub": "Actuators fail with no warning. The fleet maintenance planner has 2,000 records and limited slots.",
        "why_label": "WHY IT MATTERS",
        "why": [("184", "surprise failures in 100 weeks on 100 aircraft", "red"), ("5 weeks", "of warning before a failure", "ink"), ("91%", "of failures can become planned repairs", "blue")],
    },
    3: {
        "kicker": "SOLUTION SUBMISSION · 2 / 4",
        "headline": ("Solution & ", "Features"),
        "solution_label": "YOUR SOLUTION",
        "solution": "A team of AI agents drafts the week's repair list. The planner approves every action.",
        "lead": ("Orchestrator", "Claude hands out the work"),
        "agents": [("1  Risk agent", "our Stage 2\nfailure model"), ("2  Stock agent", "spare parts\nSIMULATED"), ("3  Supply agent", "missing parts\nSIMULATED")],
        "approve": ("The planner approves", "Work orders: SIMULATED"),
        "features_label": "KEY FEATURES & FUNCTIONALITY",
        "features": ["Live team of agents", "A hologram per actuator", "Approve, reject, change", "Blank readings handled", "Model failure handled", "Every step logged"],
    },
    4: {
        "kicker": "SOLUTION SUBMISSION · 3 / 4",
        "headline": ("Technical Stack & ", "Implementation"),
        "stack_label": "CORE TECHNOLOGIES & RATIONALE",
        "stack": [("Stage 2 model", "logistic regression + LightGBM"), ("Claude Sonnet 5.5", "plans each agent's next step"), ("FastAPI + SQLite", "every step is logged"),
                  ("Docker", "one command, no key needed"), ("110 tests", "every failure path")],
        "figures": [("0.709", "F1, unseen aircraft"), ("185 of 187", "failures flagged ahead"), ("5 weeks", "typical warning")],
        "challenges_label": "IMPLEMENTATION CHALLENGES",
        "missing": ("MISSING INPUT", "Both key readings blank: no guess, a repeat test."),
        "outage": ("TOOL FAILURE", "The model does not answer: the review stops. Try again."),
        "also": "Also handled:  one blank reading (still predicted, reduced confidence)   ·   no API key",
    },
    5: {
        "kicker": "SOLUTION SUBMISSION · 4 / 4 · DEMO & IMPACT",
        "note": "Click to play. 2 minutes. Captions on screen, so no sound is needed.",
        "link": ("If it does not play:  ", "youtu.be/CbSBeCJjVRM", "https://youtu.be/CbSBeCJjVRM"),
    },
    6: {
        "kicker": "SOLUTION SUBMISSION · 4 / 4 · DEMO & IMPACT",
        "headline": ("The ", "Impact"),
        "now_label": "IMMEDIATE IMPACT",
        "now": "184 surprise groundings become 17.",
        "before": ("TODAY", "184 surprises"),
        "after": ("WITH ACUMAIN", "167 planned", "17 surprises"),
        "now_note": "91% planned with the same 2 hangar slots a week. A replay of the training fleet, not a trial.",
        "future_label": "POTENTIAL FUTURE IMPACT",
        "future": ["Actuator history: F1 0.71 to 0.77", "Real stock and maintenance systems", "GAL's costs: the value in money"],
        "stats": [("185 of 187", "failures flagged ahead"), ("5 weeks", "of warning"), ("91%", "planned repairs")],
        "title": ("Thank ", "You"),
        "run_label": "RUN IT",
        "command": "docker compose up --build",
        "address": "http://localhost:8787",
        "notes": "Works with no API key",
        "site": ("Try it online:  ", "acumain.vercel.app", "https://acumain.vercel.app"),
        "video": ("Demo video:  ", "youtu.be/CbSBeCJjVRM", "https://youtu.be/CbSBeCJjVRM"),
        "limits": "Limits: synthetic data, one record per aircraft. Stock, supply and work orders are simulated. A person approves every action.",
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


def node(slide, x, y, w, h, title, sub, kind="agent", size=14):
    """A box of the diagram, in the style of the dashboard's team screen."""
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shape.adjustments[0] = 0.12
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = WASH if kind == "main" else WHITE
    shape.line.color.rgb = BLUE if kind == "main" else INK if kind == "approve" else LINE2
    shape.line.width = Pt(1.75 if kind in ("main", "approve") else 1)
    frame = shape.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.margin_left = frame.margin_right = Inches(0.03)
    frame.margin_top = frame.margin_bottom = Inches(0.03)
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = title
    run.font.size, run.font.name = Pt(size), HEAD
    run.font.color.rgb = INK
    for text in sub.split("\n"):
        q = frame.add_paragraph()
        q.alignment = PP_ALIGN.CENTER
        r = q.add_run()
        r.text = text
        r.font.size, r.font.name = Pt(size - 3.5), FONT
        r.font.color.rgb = RED if "SIMULATED" in text else INK2
    return shape


def picture(slide, name, x, y, w, h, left=0.0, right=1.0, top=0.0, bottom=1.0, border=True):
    """A screenshot cropped to a region and fitted to a w by h frame (the crop is trimmed to the frame's shape)."""
    path = SCREENS / name
    px, py = Image.open(path).size
    cw, ch = px * (right - left), py * (bottom - top)
    want = w / h
    if cw / ch > want:                                   # too wide: trim both sides
        cut = (cw - ch * want) / px / 2
        left, right = left + cut, right - cut
    else:                                                # too tall: trim the bottom
        bottom = top + (cw / want) / py
    pic = slide.shapes.add_picture(str(path), Inches(x), Inches(y))
    pic.crop_left, pic.crop_right, pic.crop_top, pic.crop_bottom = left, 1 - right, top, 1 - bottom
    pic.left, pic.top, pic.width, pic.height = Inches(x), Inches(y), Inches(w), Inches(h)
    if border:
        pic.line.color.rgb = LINE2
        pic.line.width = Pt(0.75)
    return pic


def page(prs, dark=False):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = DARK if dark else BG
    return slide


def start(prs, number, kicker, headline):
    """A content slide: the template's kicker and its two-tone heading, in the dashboard's type."""
    slide = page(prs)
    box(slide, LEFT, 0.5, 8, 0.3, [(kicker, 11, BLUE, HEAD)])
    box(slide, LEFT, 0.8, RIGHT - LEFT, 0.8, [([(headline[0], INK, HEAD), (headline[1], BLUE, HEAD)], 34, INK, HEAD)])
    rule(slide, LEFT, 1.62, RIGHT, 1.62, INK, 1)
    box(slide, LEFT, 7.02, 8, 0.3, [(FOOTER, 9.5, INK3, FONT)])
    box(slide, RIGHT - 1, 7.02, 1, 0.3, [(f"{number} / 6", 9.5, INK3, FONT, {"align": PP_ALIGN.RIGHT})])
    return slide


def link(slide, x, y, w, lead, shown, address, size=13, colour=INK2, accent=BLUE, whole=False):
    """A line that ends in a clickable web address. With `whole`, the box itself is the link, so the text keeps
    its own colour (PowerPoint paints linked text in the theme's dark blue, which cannot be read on the dark slide)."""
    shape = box(slide, x, y, w, 0.34, [(lead, size, colour, FONT)], MSO_ANCHOR.MIDDLE)
    run = shape.text_frame.paragraphs[0].add_run()
    run.text = shown
    run.font.size, run.font.name, run.font.underline = Pt(size), HEAD, True
    if whole:
        shape.click_action.hyperlink.address = address
    else:
        run.hyperlink.address = address
    run.font.color.rgb = accent
    return shape


def label(slide, x, y, w, text, colour=INK3):
    box(slide, x, y, w, 0.28, [(text, 10.5, colour, HEAD)])


def stat(slide, x, y, w, number, text, colour=INK, size=36):
    """A big number with a few words under it."""
    high = size / 72 * 1.22
    box(slide, x, y, w, high, [(number, size, colour, HEAD)])
    box(slide, x, y + high + 0.02, w - 0.2, 0.6, [(text, 11.5, INK2, FONT)])


def pill(slide, x, y, w, text, fill=SUNKEN, outline=LINE2, colour=INK, size=11.5, font=FONT):
    shape = block(slide, x, y, w, 0.42, fill, outline, rounded=0.5)
    frame = shape.text_frame
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.margin_left = frame.margin_right = Inches(0.08)
    p = frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.size, run.font.name = Pt(size), font
    run.font.color.rgb = colour
    return shape


def waffle(slide, x, y, blue, total=184, columns=23, pitch=0.1, side=0.08):
    """One square per failure: the first `blue` are planned repairs, the rest are surprises."""
    for i in range(total):
        block(slide, x + (i % columns) * pitch, y + (i // columns) * pitch, side, side, BLUE if i < blue else RED)


def mark(slide, x, y, size):
    """The dashboard's mark: a gauge needle over its pivot, in a dark rounded square."""
    block(slide, x, y, size, size, INK, rounded=0.22)
    u = size / 32
    rule(slide, x + 16 * u, y + 7 * u, x + 16 * u, y + 19 * u, WHITE, 2.4)
    rule(slide, x + 16 * u, y + 12 * u, x + 22 * u, y + 17 * u, WHITE, 2.4)
    pivot = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x + 12.4 * u), Inches(y + 19.4 * u), Inches(7.2 * u), Inches(7.2 * u))
    pivot.shadow.inherit = False
    pivot.fill.background()
    pivot.line.color.rgb = WHITE
    pivot.line.width = Pt(2.4)


def build(out: Path = OUT) -> Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(W), Inches(H)
    students = TEAM["students"]

    # ---- 1. title: the project, the team and the students, with the hologram as the picture
    c = CONTENT[1]
    s = page(prs)
    px = 7.75                                                    # the dark panel starts here
    block(s, px, 0, W - px, H, DARK)
    box(s, LEFT, 0.62, 6.8, 0.3, [(c["kicker"], 10.5, BLUE, HEAD)])
    mark(s, LEFT, 1.2, 0.86)
    box(s, LEFT + 1.08, 0.98, 5.6, 1.25, [([(c["title"][0], INK, HEAD), (c["title"][1], BLUE, HEAD)], 64, INK, HEAD)], MSO_ANCHOR.MIDDLE)
    box(s, LEFT, 2.5, 6.7, 0.5, [(c["tagline"], 22, INK2, FONT)])
    y = 3.35
    for name, value in c["rows"]:
        rule(s, LEFT, y, LEFT + 6.5, y, LINE2, 0.75)
        box(s, LEFT, y, 1.3, 0.44, [(name, 9.5, INK3, HEAD)], MSO_ANCHOR.MIDDLE)
        box(s, LEFT + 1.35, y, 5.15, 0.44, [(value, 14, INK, FONT)], MSO_ANCHOR.MIDDLE)
        y += 0.44
    rule(s, LEFT, y, LEFT + 6.5, y, LINE2, 0.75)
    label(s, LEFT, y + 0.2, 3, c["students_label"])
    y += 0.5
    for i, (name, number) in enumerate(students):                # one student a line: the name, then the number in its own column
        box(s, LEFT, y + i * 0.33, 4.1, 0.32, [(name, 13, INK, FONT)], MSO_ANCHOR.MIDDLE)
        box(s, LEFT + 4.2, y + i * 0.33, 2.3, 0.32, [(number, 12, INK3, MONO)], MSO_ANCHOR.MIDDLE)
    hw = 5.1
    hh = hw * 0.681                                              # the hologram's own shape, so nothing of it is cut
    hx = px + (W - px - hw) / 2
    box(s, hx, 1.5, hw, 0.3, [(c["panel_label"], 10.5, CYAN, HEAD)])
    picture(s, "hologram.png", hx, 1.9, hw, hh, left=0.02, right=0.98, top=0.025, bottom=0.975, border=False)      # the crop takes the rounded corners off
    box(s, hx, 1.9 + hh + 0.24, hw, 0.8, [(c["panel_caption"], 15, MIST, FONT, {"spacing": 1.1})])
    box(s, LEFT, 7.02, 6, 0.3, [(FOOTER, 9.5, INK3, FONT)])
    box(s, W - 1.7, 7.02, 1, 0.3, [("1 / 6", 9.5, GREY, FONT, {"align": PP_ALIGN.RIGHT})])

    # ---- 2. introduction and problem
    c = CONTENT[2]
    s = start(prs, 2, c["kicker"], c["headline"])
    aw = 4.15
    label(s, LEFT, 1.95, aw, c["project_label"])
    mark(s, LEFT, 2.3, 0.5)
    box(s, LEFT + 0.65, 2.3, aw - 0.65, 0.5, [(c["project"], 26, INK, HEAD)], MSO_ANCHOR.MIDDLE)
    rule(s, LEFT, 3.05, LEFT + aw, 3.05, LINE2, 0.75)
    label(s, LEFT, 3.2, aw, c["team_label"])
    for i, (name, _) in enumerate(students):
        box(s, LEFT, 3.52 + i * 0.34, aw, 0.32, [(name, 14, INK, FONT)], MSO_ANCHOR.MIDDLE)
    cy = 3.52 + max(len(students), 1) * 0.34 + 0.16
    rule(s, LEFT, cy, LEFT + aw, cy, LINE2, 0.75)
    label(s, LEFT, cy + 0.15, aw, c["case_label"])
    pill(s, LEFT, cy + 0.48, 1.05, c["case"][0], WASH, BLUE, BLUE, 12.5, HEAD)
    box(s, LEFT + 1.2, cy + 0.48, aw - 1.2, 0.42, [(c["case"][1], 12, INK2, FONT)], MSO_ANCHOR.MIDDLE)
    rule(s, 5.2, 1.95, 5.2, 6.7, LINE2, 0.75)
    bx, bw = 5.55, RIGHT - 5.55
    label(s, bx, 1.95, bw, c["challenge_label"])
    box(s, bx, 2.24, bw, 1.0, [(c["challenge"], 28, INK, HEAD, {"spacing": 1.0})])
    box(s, bx, 3.3, bw, 0.62, [(c["challenge_sub"], 14, INK2, FONT, {"spacing": 1.1})])
    rule(s, bx, 4.15, RIGHT, 4.15, LINE2, 0.75)
    label(s, bx, 4.3, bw, c["why_label"])
    tw = bw / 3
    for i, (number, text, tone) in enumerate(c["why"]):
        stat(s, bx + i * tw, 4.66, tw, number, text, TONE[tone], 38)

    # ---- 3. solution and features: the agents as a diagram, and two large pictures from the dashboard
    c = CONTENT[3]
    s = start(prs, 3, c["kicker"], c["headline"])
    aw = 4.25
    label(s, LEFT, 1.95, aw, c["solution_label"])
    box(s, LEFT, 2.24, aw, 0.95, [(c["solution"], 15, INK, HEAD, {"spacing": 1.08})])
    row1, row2, row3 = 3.32, 4.3, 5.72
    node(s, LEFT, row1, aw, 0.7, *c["lead"], kind="main")
    gap = 0.1
    nw = (aw - 2 * gap) / 3
    for i, (title, sub) in enumerate(c["agents"]):
        x = LEFT + i * (nw + gap)
        rule(s, x + nw / 2, row1 + 0.7, x + nw / 2, row2, INK2, 1.25, arrow=True)
        node(s, x, row2, nw, 1.12, title, sub, size=11.5)
        rule(s, x + nw / 2, row2 + 1.12, x + nw / 2, row3, INK2, 1.25, arrow=True)
    node(s, LEFT, row3, aw, 0.7, *c["approve"], kind="approve")
    bx = 5.35
    bw = RIGHT - bx
    label(s, bx, 1.95, bw, c["features_label"])
    ph = (bw - 0.15) / (1.453 + 1.248)                          # both pictures at one height, each at its own shape
    picture(s, "hologram.png", bx, 2.26, ph * 1.453, ph, left=0.02, right=0.98, top=0.025, bottom=0.975)
    picture(s, "decide-window.png", bx + ph * 1.453 + 0.15, 2.26, ph * 1.248, ph)
    fw = (bw - 0.3) / 3
    for i, text in enumerate(c["features"]):
        pill(s, bx + (i % 3) * (fw + 0.15), 2.26 + ph + 0.28 + (i // 3) * 0.54, fw, text, size=12.5)

    # ---- 4. technical stack and implementation: the two failure cases as wide close-ups that can be read
    c = CONTENT[4]
    s = start(prs, 4, c["kicker"], c["headline"])
    aw = 4.85
    label(s, LEFT, 1.95, aw, c["stack_label"])
    y = 2.28
    for i, (tech, why) in enumerate(c["stack"]):
        rule(s, LEFT, y, LEFT + aw, y, INK if i == 0 else LINE2, 1 if i == 0 else 0.75)
        box(s, LEFT, y, 2.05, 0.52, [(tech, 14.5, BLUE, HEAD)], MSO_ANCHOR.MIDDLE)
        box(s, LEFT + 2.1, y, aw - 2.1, 0.52, [(why, 12.5, INK2, FONT)], MSO_ANCHOR.MIDDLE)
        y += 0.52
    rule(s, LEFT, y, LEFT + aw, y, LINE2, 0.75)
    x = LEFT
    for i, ((number, text), fw3) in enumerate(zip(c["figures"], (1.5, 2.0, 1.35))):
        stat(s, x, y + 0.3, fw3, number, text, BLUE if i == 1 else INK, 24)
        x += fw3
    bx = 6.0
    bw = RIGHT - bx
    label(s, bx, 1.95, bw, c["challenges_label"])
    y = 2.28
    for name, key, (l, r, top, bottom) in (("missing.png", "missing", (0.07, 0.62, 0.165, 0.375)), ("outage.png", "outage", (0.07, 0.62, 0.225, 0.49))):
        px, py = Image.open(SCREENS / name).size
        high = bw * (py * (bottom - top)) / (px * (r - l))
        picture(s, name, bx, y, bw, high, left=l, right=r, top=top, bottom=bottom)
        tag, text = c[key]
        box(s, bx, y + high + 0.08, bw, 0.3, [([(tag + "   ", RED, HEAD), (text, INK, FONT)], 13, INK, FONT)])
        y += high + 0.5
    box(s, bx, y, bw, 0.3, [(c["also"], 11.5, INK3, FONT)])

    # ---- 5. the demo video alone, as large as the slide allows, on a dark page
    c = CONTENT[5]
    s = page(prs, dark=True)
    vh = 6.86
    vw = vh * 16 / 9
    vx, vy = (W - vw) / 2, 0.1
    if VIDEO.is_file():
        s.shapes.add_movie(str(VIDEO), Inches(vx), Inches(vy), Inches(vw), Inches(vh), poster_frame_image=str(SCREENS / "team-29.png"), mime_type="video/mp4")
    else:
        picture(s, "team-29.png", vx, vy, vw, vh, border=False)
    box(s, vx, 7.04, 7.9, 0.34, [([(c["kicker"] + "     ", CYAN, HEAD), (c["note"], MIST, FONT)], 10.5, MIST, FONT)], MSO_ANCHOR.MIDDLE)
    fallback = link(s, W - vx - 0.75 - 3.6, 7.04, 3.6, *c["link"], size=10.5, colour=MIST, accent=CYAN, whole=True)
    fallback.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT
    box(s, W - vx - 0.6, 7.04, 0.6, 0.34, [("5 / 6", 9.5, GREY, FONT, {"align": PP_ALIGN.RIGHT})], MSO_ANCHOR.MIDDLE)

    # ---- 6. the impact (every failure as a square), then thank you with how to run it and the limits
    c = CONTENT[6]
    s = start(prs, 6, c["kicker"], c["headline"])
    label(s, LEFT, 1.9, 6.6, c["now_label"])
    box(s, LEFT, 2.16, 6.8, 0.55, [(c["now"], 24, INK, HEAD)])
    pitch = 0.13
    ww = 23 * pitch
    x2 = LEFT + ww + 0.4
    box(s, LEFT, 2.86, ww, 0.62, [(c["before"][0], 9.5, INK3, HEAD), (c["before"][1], 17, RED, HEAD)])
    box(s, x2, 2.86, ww + 0.2, 0.62, [(c["after"][0], 9.5, BLUE, HEAD), ([(c["after"][1], BLUE, HEAD), ("   " + c["after"][2], RED, HEAD)], 17, BLUE, HEAD)])
    waffle(s, LEFT, 3.56, 0, pitch=pitch, side=0.105)
    waffle(s, x2, 3.56, 167, pitch=pitch, side=0.105)
    box(s, LEFT, 4.7, 6.6, 0.3, [(c["now_note"], 10.5, INK3, FONT)])
    bx = 7.95
    bw = RIGHT - bx
    label(s, bx, 1.9, bw, c["future_label"], BLUE)
    for i, text in enumerate(c["future"]):
        box(s, bx, 2.2 + i * 0.46, 0.35, 0.42, [(str(i + 1), 17, BLUE, HEAD)], MSO_ANCHOR.MIDDLE)
        box(s, bx + 0.42, 2.2 + i * 0.46, bw - 0.42, 0.42, [(text, 14, INK, FONT)], MSO_ANCHOR.MIDDLE)
    rule(s, bx, 3.72, RIGHT, 3.72, LINE2, 0.75)
    x = bx
    for i, ((number, text), sw) in enumerate(zip(c["stats"], (1.95, 1.5, 1.2))):
        box(s, x, 3.84, sw, 0.5, [(number, 22, BLUE if i == 2 else INK, HEAD)])
        box(s, x, 4.3, sw - 0.1, 0.5, [(text, 10, INK2, FONT)])
        x += sw
    by, bh = 5.14, 1.42
    block(s, LEFT, by, RIGHT - LEFT, bh, DARK, rounded=0.08)
    box(s, LEFT + 0.4, by + 0.18, 3.6, 0.7, [([(c["title"][0], WHITE, HEAD), (c["title"][1], CYAN, HEAD)], 36, WHITE, HEAD)], MSO_ANCHOR.MIDDLE)
    box(s, LEFT + 0.42, by + 0.92, 3.6, 0.3, [(f"{TEAM['team']}  ·  {TEAM['university']}", 11.5, MIST, FONT)])
    rx = LEFT + 4.35
    box(s, rx, by + 0.18, 0.8, 0.24, [(c["run_label"], 9.5, CYAN, HEAD)], MSO_ANCHOR.MIDDLE)
    box(s, rx + 0.8, by + 0.18, 3, 0.24, [(c["notes"], 10, MIST, FONT)], MSO_ANCHOR.MIDDLE)
    box(s, rx, by + 0.42, 7.3, 0.4, [([(c["command"], WHITE, MONO), ("    " + c["address"], CYAN, MONO)], 16, WHITE, MONO)], MSO_ANCHOR.MIDDLE)
    link(s, rx, by + 0.9, 3.4, *c["site"], size=12.5, colour=MIST, accent=CYAN, whole=True)
    link(s, rx + 3.75, by + 0.9, 3.5, *c["video"], size=12.5, colour=MIST, accent=CYAN, whole=True)
    box(s, LEFT, by + bh + 0.08, RIGHT - LEFT, 0.28, [(c["limits"], 9.5, INK3, FONT)])

    prs.save(str(out))
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    print(f"Wrote {build(target)}" + (" (with the demo video)" if VIDEO.is_file() else " (no video found: slide 5 shows a still picture)"))
