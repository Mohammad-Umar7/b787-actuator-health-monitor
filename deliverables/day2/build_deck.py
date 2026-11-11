"""Build the Day 2 deck: deliverables/day2/Team Maze - Al Ain University.pptx (six slides, no sound).

    .venv\\Scripts\\python deliverables\\day2\\build_deck.py

The words are all in CONTENT below. The pictures come from deliverables/day2/screens (made by capture.py), so a
screenshot can be retaken and the deck rebuilt. If deliverables/day2/demo.mp4 exists it is embedded on slide 3;
if not, slide 3 shows the team screen in the video's place and says where the video goes.
Needs python-pptx (pip install python-pptx). The look follows the dashboard: off-white page, ink text, thin rules,
red only for failures, blue only for the one main thing.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).resolve().parent
SCREENS = HERE / "screens"
VIDEO = HERE / "demo.mp4"
OUT = HERE / "Team Maze - Al Ain University.pptx"

# ---------------------------------------------------------------------------- every word on the slides
FOOTER = "AcuMain · Team Maze, Al Ain University · Case 1: Boeing 787 nose landing gear actuator"
CONTENT = {
    1: {
        "headline": "Which aircraft get this week's hangar slots?",
        "kicker": "THE USER, THE PROBLEM, THE BUSINESS CASE",
        "lines": [
            ("User", "The fleet maintenance planning manager, who assigns hangar slots, spare actuators and technicians each week."),
            ("Problem", "Nose landing gear actuators fail without warning: 184 failures in 100 weeks on 100 aircraft, from 0 to 7 in one week."),
            ("Business case", "Decide which actuators to repair, inspect or re-test this week, about 5 weeks before they fail, not after a surprise grounding."),
            ("Solution", "A team of AI agents turns our failure model into the week's repair list, with a spare part for each repair. The planner approves every action."),
            ("Expected value", "With 2 hangar slots a week, 91% of failures (167 of 184) become planned repairs. Today: none."),
        ],
        "team": "Team Maze, Al Ain University: Mohammad Umar, Farooq Shafeek, Abdulahad, Sadiq, Zubair",
        "caption": "The planner's page after a review of the 2,000-record fleet file: what is likely to fail, and what the team recommends.",
    },
    2: {
        "headline": "The agent workflow: four agents, one trained model.",
        "nodes": {
            "planner": ("Planner", "Brings in the records"),
            "dashboard": ("Dashboard", "FastAPI, one Docker image"),
            "lead": ("Orchestrator", "Claude Sonnet 5.5 hands out the work"),
            "approve": ("Planner approves", "Work orders: SIMULATED"),
            "risk": ("1  Risk agent", "check_records · run_failure_model\nlist_records · propose_actions"),
            "stock": ("2  Stock agent", "check_stock · reserve_parts"),
            "supply": ("3  Supply agent", "get_supply_options · request_parts"),
            "model": ("Failure model", "Our Stage 2 model with its fitted preprocessing"),
            "store": ("Hangar store", "SIMULATED"),
            "depot": ("Supply department", "SIMULATED"),
        },
        "lines": [
            "In order: the Orchestrator briefs 1 the Risk agent (model, actions), 2 the Stock agent (parts in store), 3 the Supply agent (missing parts), then reports to the planner.",
            "Every step is logged with its exact input and output. With no key, or if Claude fails, a built-in planner runs the same tools.",
            "If the model call fails, the review stops and nothing is invented. Simulated and labelled: spare-parts stock, supply department, work orders.",
        ],
    },
    3: {
        "headline": "Workflow: watch it work",
        "steps": [
            ("Pick a file", "Upload records, use the sample fleet, or type in one aircraft."),
            ("The team of agents reviews it", "Arrows show each message between agents. Every dot is one aircraft."),
            ("The action list", "Each repair with its risk, its reason and its spare part."),
            ("You approve, reject or change", "Only an approval creates a work order."),
        ],
        "video_caption": "Demo video, 2 minutes. Click to play. Every step is captioned, so it reads with the sound off.",
        "placeholder_caption": "Demo video goes here: Insert > Video > This device",
        "decide_caption": "The decision window. Reject asks \"Are you sure?\" first, and any decision can be changed later.",
    },
    4: {
        "headline": "It warns early, and it says so when it cannot predict.",
        "figures": [
            ("0.709", "F1 on aircraft the model never saw", "0.740 on replacement actuators, the kind in the test set"),
            ("185 of 187", "failures flagged in their final 30 days", "typically 5 weeks ahead"),
            ("110", "automated tests", "input checks, every tool, every failure path"),
        ],
        "missing": "Missing input: both key readings are blank, so no prediction is made and a repeat test is proposed.",
        "outage": "Tool failure: the model call fails, the review stops, nothing is proposed and no risk is invented.",
        "model": "The model: logistic regression (75%) with gradient-boosted trees (25%), on each reading divided by that test's reference settings, trained on the 10,000 Stage 2 records. "
                 "The 0.709 is our own validation; the official Stage 2 score is the organisers', from our submitted test predictions.",
    },
    5: {
        "headline": "Two hangar slots a week turn 91% of surprise failures into planned repairs.",
        "bars": [
            ("Today: repair after failure", 0, None, "0 of 184 planned", "grey"),
            ("2 slots a week, oldest actuators first", 65, 79, "65% to 79% planned", "grey"),
            ("2 slots a week, AcuMain's risk list first", 91, None, "91% planned: 167 of 184", "blue"),
        ],
        "lines": [
            "Measure of success: the share of failures that become planned repairs, not surprise groundings.",
            "Demonstrated: 185 of 187 failures flagged about 5 weeks ahead on unseen aircraft; a review of 2,000 records takes about 40 seconds.",
            "Projected: the 91% comes from a replay of the 100 training aircraft, not a trial. A 5-week warning also covers the 14-day supplier lead time.",
        ],
        "honest": "Value per year = surprises turned into planned repairs x (cost of a surprise grounding minus cost of a planned repair). The money value needs GAL's cost figures.",
    },
    6: {
        "headline": "Limits, and what comes next.",
        "limits_title": "Limits",
        "limits": [
            "One diagnostic record per aircraft, no history: about one Yes in three comes a few weeks early.",
            "Synthetic hackathon data: the numbers need re-checking on GAL's real records.",
            "Spare-parts stock, supply department and work orders are simulated.",
            "A planning aid, not a certified aviation system: a person approves every action.",
        ],
        "run_title": "Run it",
        "commands": ["docker compose up --build", "http://localhost:8787"],
        "run_notes": ["Works with no API key.", "Public replay: acumain.vercel.app"],
        "next_title": "Next steps",
        "next": [
            ("Use each actuator's history", "In our tests that lifts F1 from 0.71 to 0.77."),
            ("Connect the real systems", "Stock, supply and maintenance, in place of the simulated ones."),
            ("Add GAL's cost figures", "To turn avoided surprise groundings into money."),
        ],
        "caption": "The first screen. One click starts the review.",
    },
}

# ---------------------------------------------------------------------------- the dashboard's look
BG, INK, INK2, INK3 = RGBColor(0xFA, 0xFA, 0xF7), RGBColor(0x16, 0x17, 0x1B), RGBColor(0x49, 0x4C, 0x54), RGBColor(0x80, 0x83, 0x8B)
LINE, LINE2, WHITE = RGBColor(0xE4, 0xE3, 0xDD), RGBColor(0xCD, 0xCC, 0xC5), RGBColor(0xFF, 0xFF, 0xFF)
RED, BLUE, WASH, SUNKEN = RGBColor(0xBD, 0x2E, 0x1A), RGBColor(0x1E, 0x46, 0xC8), RGBColor(0xED, 0xF1, 0xFC), RGBColor(0xF2, 0xF2, 0xED)
FONT, HEAD, MONO = "Segoe UI", "Segoe UI Semibold", "Consolas"
W, H = 13.333, 7.5
LEFT, RIGHT = 0.7, 12.633


def box(slide, x, y, w, h, paragraphs, anchor=MSO_ANCHOR.TOP):
    """A text box. `paragraphs` is a list of (text, size, colour, font, extra) where extra may set align or space_after."""
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
        p.line_spacing = extra.get("spacing", 1.08)
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
        tail = ln.makeelement(qn("a:tailEnd"), {"type": "triangle", "w": "med", "len": "med"})
        ln.append(tail)
    return line


def node(slide, x, y, w, h, title, sub, kind="agent"):
    """A box of the diagram, in the style of the dashboard's team screen."""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE if kind in ("model", "system") else MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    if kind not in ("model", "system"):
        shape.adjustments[0] = 0.12
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = WASH if kind == "main" else SUNKEN if kind == "system" else WHITE
    shape.line.color.rgb = BLUE if kind == "main" else INK if kind == "model" else LINE2
    shape.line.width = Pt(1.5 if kind in ("model", "main") else 1)
    if kind == "system":
        shape.line.dash_style = 4            # dashed: this part is simulated
    frame = shape.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    frame.margin_left = frame.margin_right = Inches(0.12)
    frame.margin_top = frame.margin_bottom = Inches(0.04)
    p = frame.paragraphs[0]
    run = p.add_run()
    run.text = title
    run.font.size, run.font.name = Pt(13), MONO if kind == "model" else HEAD
    run.font.color.rgb = INK
    for line in sub.split("\n"):
        q = frame.add_paragraph()
        r = q.add_run()
        r.text = line
        mono = "_" in line
        r.font.size, r.font.name = Pt(9.5 if mono else 10.5), MONO if mono else FONT
        r.font.color.rgb = RED if "SIMULATED" in line else INK2
    return shape


def picture(slide, name, x, y, width, top=0.0, bottom=1.0, left=0.0, right=1.0):
    """A screenshot, cropped to a part of it, with the dashboard's thin border. Returns its height in inches."""
    path = SCREENS / name
    px, py = Image.open(path).size
    height = width * (py * (bottom - top)) / (px * (right - left))
    pic = slide.shapes.add_picture(str(path), Inches(x), Inches(y))
    pic.crop_left, pic.crop_right, pic.crop_top, pic.crop_bottom = left, 1 - right, top, 1 - bottom
    pic.left, pic.top, pic.width, pic.height = Inches(x), Inches(y), Inches(width), Inches(height)
    pic.line.color.rgb = LINE2
    pic.line.width = Pt(0.75)
    return height


def start(prs, number, headline):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = BG
    box(slide, LEFT, 0.42, RIGHT - LEFT, 0.88, [(headline, 24, INK, HEAD)], MSO_ANCHOR.BOTTOM)
    rule(slide, LEFT, 1.42, RIGHT, 1.42, INK, 1)
    box(slide, LEFT, 6.98, 10, 0.3, [(FOOTER, 9.5, INK3, FONT)])
    box(slide, RIGHT - 1, 6.98, 1, 0.3, [(f"{number} / 6", 9.5, INK3, FONT, {"align": PP_ALIGN.RIGHT})])
    return slide


def caption(slide, x, y, w, text, colour=INK3):
    box(slide, x, y, w, 0.5, [(text, 10.5, colour, FONT)])


def build() -> Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(W), Inches(H)

    # ---- 1. the user and the decision
    c = CONTENT[1]
    s = start(prs, 1, c["headline"])
    box(s, LEFT, 1.72, 4.6, 0.3, [(c["kicker"], 10, INK3, HEAD)])
    y = 2.04
    for i, (label, text) in enumerate(c["lines"]):
        rule(s, LEFT, y, LEFT + 4.6, y, INK if i == 0 else LINE2, 1 if i == 0 else 0.75)
        box(s, LEFT, y + 0.1, 1.3, 0.7, [(label, 11, BLUE if label in ("Solution", "Expected value") else INK, HEAD)])
        box(s, LEFT + 1.32, y + 0.1, 3.28, 0.72, [(text, 10.5, INK2, FONT)])
        y += 0.84
    rule(s, LEFT, y, LEFT + 4.6, y, LINE2, 0.75)
    box(s, LEFT, y + 0.1, 4.6, 0.5, [(c["team"], 10, INK3, FONT)])
    high = picture(s, "result.png", 5.6, 1.72, 7.03, bottom=0.93)
    caption(s, 5.6, 1.72 + high + 0.1, 7.03, c["caption"])

    # ---- 2. architecture
    c = CONTENT[2]
    s = start(prs, 2, c["headline"])
    n = c["nodes"]
    row1, row2, row3 = 1.78, 3.02, 4.42
    node(s, 0.7, row1, 1.9, 0.78, *n["planner"])
    node(s, 3.1, row1, 2.6, 0.78, *n["dashboard"])
    node(s, 6.2, row1, 3.3, 0.78, *n["lead"], kind="main")
    node(s, 10.3, row1, 2.33, 0.78, *n["approve"])
    for x1, x2 in ((2.6, 3.1), (5.7, 6.2), (9.5, 10.3)):
        rule(s, x1, row1 + 0.39, x2, row1 + 0.39, INK2, 1, arrow=True)
    agents = {"risk": (2.0, 3.6), "stock": (6.2, 2.75), "supply": (9.55, 3.08)}
    systems = {"risk": ("model", "model"), "stock": ("store", "system"), "supply": ("depot", "system")}
    rule(s, 7.85, row1 + 0.78, 7.85, row1 + 0.98, INK2, 1)
    rule(s, 3.8, row1 + 0.98, 11.09, row1 + 0.98, INK2, 1)
    for key, (x, w) in agents.items():
        mid = x + w / 2
        rule(s, mid, row1 + 0.98, mid, row2, INK2, 1, arrow=True)
        node(s, x, row2, w, 0.98, *n[key])
        rule(s, mid, row2 + 0.98, mid, row3, INK2, 1, arrow=True)
        name, kind = systems[key]
        node(s, x, row3, w, 0.78, *n[name], kind=kind)
    y = 5.52
    for text in c["lines"]:
        rule(s, LEFT, y, RIGHT, y, LINE2, 0.75)
        box(s, LEFT, y + 0.09, RIGHT - LEFT, 0.4, [(text, 11.5, INK2, FONT)])
        y += 0.46

    # ---- 3. workflow: the demo video, with the four steps beside it
    c = CONTENT[3]
    s = start(prs, 3, c["headline"])
    fx, fy, fw = LEFT, 1.72, 8.05
    fh = fw * 9 / 16
    if VIDEO.is_file():
        s.shapes.add_movie(str(VIDEO), Inches(fx), Inches(fy), Inches(fw), Inches(fh), poster_frame_image=str(SCREENS / "team-29.png"), mime_type="video/mp4")
        caption(s, fx, fy + fh + 0.1, fw, c["video_caption"])
    else:
        picture(s, "team-29.png", fx, fy, fw)
        caption(s, fx, fy + fh + 0.1, fw, c["placeholder_caption"], BLUE)
    sx, y = 9.15, 1.72
    for i, (title, text) in enumerate(c["steps"], 1):
        rule(s, sx, y, RIGHT, y, INK if i == 1 else LINE2, 1 if i == 1 else 0.75)
        box(s, sx, y + 0.1, 0.4, 0.5, [(str(i), 20, BLUE, HEAD)])
        box(s, sx + 0.45, y + 0.13, RIGHT - sx - 0.45, 0.72, [(title, 13, INK, HEAD, {"after": 2}), (text, 10.5, INK2, FONT)])
        y += 0.84
    rule(s, sx, y, RIGHT, y, LINE2, 0.75)
    high = picture(s, "decide-window.png", sx, y + 0.16, 1.62)
    if (SCREENS / "hologram.png").is_file():
        # the hologram of one aircraft's actuator sits next to the decision window, with one caption under both
        picture(s, "hologram.png", sx + 1.78, y + 0.16, RIGHT - sx - 1.78)
        caption(s, sx, y + 0.16 + high + 0.08, RIGHT - sx, "The decision window, and the hologram of that aircraft's actuator.")
    else:
        box(s, sx + 1.75, y + 0.16, RIGHT - sx - 1.75, high, [(c["decide_caption"], 10, INK3, FONT)], MSO_ANCHOR.MIDDLE)

    # ---- 4. validation, and the failures it handles
    c = CONTENT[4]
    s = start(prs, 4, c["headline"])
    gap, fw3 = 0.4, (RIGHT - LEFT - 0.8) / 3
    for i, (number, label, note) in enumerate(c["figures"]):
        x = LEFT + i * (fw3 + gap)
        rule(s, x, 1.74, x + fw3, 1.74, LINE2, 0.75)
        box(s, x, 1.82, fw3, 0.62, [(number, 30, INK, HEAD)])
        box(s, x, 2.44, fw3, 0.55, [(label, 12, INK, HEAD, {"after": 1}), (note, 10.5, INK3, FONT)])
    pw = (RIGHT - LEFT - 0.4) / 2
    high = picture(s, "missing.png", LEFT, 3.28, pw, top=0.13, bottom=0.88)
    caption(s, LEFT, 3.28 + high + 0.1, pw, c["missing"], INK2)
    high = picture(s, "outage.png", LEFT + pw + 0.4, 3.28, pw, top=0.0, bottom=0.75)
    caption(s, LEFT + pw + 0.4, 3.28 + high + 0.1, pw, c["outage"], INK2)
    rule(s, LEFT, 6.4, RIGHT, 6.4, LINE2, 0.75)
    box(s, LEFT, 6.47, RIGHT - LEFT, 0.45, [(c["model"], 10.5, INK2, FONT)])

    # ---- 5. value
    c = CONTENT[5]
    s = start(prs, 5, c["headline"])
    bx, bw, y = 4.55, 5.6, 1.95
    for label, low, high_value, text, tone in c["bars"]:
        box(s, LEFT, y, bx - LEFT - 0.3, 0.52, [(label, 13, INK if tone == "blue" else INK2, HEAD if tone == "blue" else FONT)], MSO_ANCHOR.MIDDLE)
        track = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(bx), Inches(y + 0.08), Inches(bw), Inches(0.36))
        track.shadow.inherit = False
        track.fill.solid()
        track.fill.fore_color.rgb = RGBColor(0xE8, 0xE7, 0xE1)
        track.line.fill.background()
        for value, colour in ((high_value, RGBColor(0xC4, 0xC5, 0xC9)), (low, BLUE if tone == "blue" else RGBColor(0x8A, 0x8D, 0x95))):
            if value:
                bar = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(bx), Inches(y + 0.08), Inches(bw * value / 100), Inches(0.36))
                bar.shadow.inherit = False
                bar.fill.solid()
                bar.fill.fore_color.rgb = colour
                bar.line.fill.background()
        box(s, bx + bw + 0.2, y, RIGHT - bx - bw - 0.2, 0.52, [(text, 12.5, BLUE if tone == "blue" else INK2, HEAD)], MSO_ANCHOR.MIDDLE)
        y += 0.82
    caption(s, bx, y - 0.14, bw, "Share of the 184 failures that become planned repairs")
    y = 4.72
    for text in c["lines"]:
        rule(s, LEFT, y, RIGHT, y, LINE2, 0.75)
        box(s, LEFT, y + 0.12, RIGHT - LEFT, 0.45, [(text, 12.5, INK2, FONT)])
        y += 0.56
    rule(s, LEFT, y, RIGHT, y, LINE2, 0.75)
    box(s, LEFT, y + 0.13, RIGHT - LEFT, 0.5, [(c["honest"], 10.5, INK3, FONT)])

    # ---- 6. next steps, and how to run it
    c = CONTENT[6]
    s = start(prs, 6, c["headline"])
    box(s, LEFT, 1.72, 5.6, 0.3, [(c["limits_title"].upper(), 10, INK3, HEAD)])
    y = 2.02
    for i, text in enumerate(c["limits"]):
        rule(s, LEFT, y, LEFT + 5.6, y, INK if i == 0 else LINE2, 1 if i == 0 else 0.75)
        box(s, LEFT, y + 0.1, 5.6, 0.62, [(text, 12, INK2, FONT)], MSO_ANCHOR.MIDDLE)
        y += 0.8
    rule(s, LEFT, y, LEFT + 5.6, y, LINE2, 0.75)
    y += 0.22
    box(s, LEFT, y, 5.6, 0.3, [(c["run_title"].upper(), 10, INK3, HEAD)])
    code = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(LEFT), Inches(y + 0.3), Inches(5.6), Inches(0.5))
    code.shadow.inherit = False
    code.fill.solid()
    code.fill.fore_color.rgb = SUNKEN
    code.line.fill.background()
    box(s, LEFT + 0.2, y + 0.3, 5.2, 0.5, [("   ".join(c["commands"]), 11.5, INK, MONO)], MSO_ANCHOR.MIDDLE)
    box(s, LEFT, y + 0.86, 5.6, 0.34, [("  ".join(c["run_notes"]), 9.5, INK3, FONT)])
    nx = 6.95
    box(s, nx, 1.72, RIGHT - nx, 0.3, [(c["next_title"].upper(), 10, INK3, HEAD)])
    y = 2.02
    for i, (title, text) in enumerate(c["next"], 1):
        rule(s, nx, y, RIGHT, y, INK if i == 1 else LINE2, 1 if i == 1 else 0.75)
        box(s, nx, y + 0.14, 0.45, 0.6, [(str(i), 22, BLUE, HEAD)])
        box(s, nx + 0.55, y + 0.17, RIGHT - nx - 0.55, 1.0, [(title, 15, INK, HEAD, {"after": 3}), (text, 12, INK2, FONT)])
        y += 1.18
    rule(s, nx, y, RIGHT, y, LINE2, 0.75)

    prs.save(OUT)
    return OUT


if __name__ == "__main__":
    made = build()
    print(f"Wrote {made} ({'with' if VIDEO.is_file() else 'without'} the demo video)")
