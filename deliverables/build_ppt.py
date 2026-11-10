"""Fill in the organisers' submission template.

  python deliverables/build_ppt.py --group 7

Needs python-pptx. Writes "deliverables/Group <n> - Al Ain University.pptx".
Edit the text in CONTENT below, then run it again.
"""
import argparse
import copy
from pathlib import Path

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "data" / "Group Number - University Name.pptx"
SCREENSHOT = ROOT / "deliverables" / "screenshots" / "dashboard-slide.png"
LIVE = "acumain.vercel.app"

CONTENT = {
    "project": "AcuMain",
    "project_line": "AcuMain: Actuator Health Monitor",
    "group_name": "AAU ENGINEERS TEAM",
    "university": "AL AIN UNIVERSITY",
    "members": "Mohammad Umar   ·   Farooq Shafeek   ·   Abdulahad   ·   Sadiq   ·   Zubair",
    "challenge": "Case 1: predict which B787 nose landing gear actuators will fail in the next 30 days, "
                 "so managers can act before an aircraft is grounded.",
    "why": "An actuator that fails without warning grounds the aircraft and forces an unplanned repair. "
           "In our data 6 of 10 failed within four months, and every one showed warning signs "
           "1 to 2 months earlier.",
    "solution": [
        "AcuMain shows managers which B787 nose gear actuators are likely to fail in the next 30 days, "
        "why, and what to decide.",
        "•  For decision-makers: fleet outlook, expected failures, ranked priorities.",
        "•  Honest: every risk has a range; tested on aircraft the model never saw.",
        "•  Ready for new data: scores a new file as soon as it arrives.",
    ],
    "features": "Fleet outlook  ·  Risk alerts  ·  Ranked priorities with a decision  ·  The reason behind every risk",
    "tech": [
        "Python, pandas, SciPy  –  clean the data and fit the model",
        "Monotone logistic regression  –  explainable, hard to overfit",
        "Leave-one-aircraft-out tests  –  proof on unseen aircraft",
        "HTML, CSS, JavaScript, SVG  –  fast, no heavy framework",
        "GitHub and Vercel  –  version control and a live link",
    ],
    "challenges": [
        "Only 6 failures  →  simple model, tested on unseen aircraft",
        "One column dominates  →  penalty, and risk can only go up",
        "More data is coming  →  cleans and scores new files at once",
        "A score is not a decision  →  ranges, reasons, clear actions",
    ],
    "demo": "Live dashboard plus a narrated walkthrough with subtitles. Pick a month, filter by risk level, "
            "and click any aircraft to see why it is at risk and what to decide.",
    "links": [("Live:  " + LIVE, "https://" + LIVE + "/"),
              ("Video:  " + LIVE + "/demo.mp4", "https://" + LIVE + "/demo.mp4")],
    "immediate": "Managers see which aircraft to repair before they fail. Today: 6 flagged High risk, about 4 "
                 "failures expected within 30 days. Surprise groundings become planned repairs.",
    "future": "Add live sensor data and every monitored component to give one fleet readiness view for "
              "planning, spares and budgets across all the aircraft GAL supports.",
}


def find(slide, name):
    return next(s for s in slide.shapes if s.name == name)


def remove(shape):
    shape._element.getparent().remove(shape._element)


def place(shape, top=None, height=None, left=None, width=None):
    for attr, value in (("top", top), ("height", height), ("left", left), ("width", width)):
        if value is not None:
            setattr(shape, attr, Inches(value))


def set_text(shape, text, size=None, links=None):
    """Replace a text box's text, keeping the template's run formatting. `text` may be a list of paragraphs."""
    paragraphs = text if isinstance(text, list) else [text]
    body = shape.text_frame._txBody
    first = shape.text_frame.paragraphs[0]
    for extra in shape.text_frame.paragraphs[1:]:
        body.remove(extra._p)
    for extra in first.runs[1:]:
        first._p.remove(extra._r)
    template = copy.deepcopy(first._p)
    for index, line in enumerate(paragraphs):
        if index:
            body.append(copy.deepcopy(template))
        run = shape.text_frame.paragraphs[index].runs[0]
        run.text = line
        if size:
            run.font.size = Pt(size)
        if links and links[index]:
            run.hyperlink.address = links[index]


def clone_rows(slide, box_name, text_name, lines, top, pitch, box_height, size):
    """Repeat the template's single row (background box plus text) once per line."""
    box, text = find(slide, box_name), find(slide, text_name)
    text_offset = (box_height - text.height / 914400) / 2
    for index, line in enumerate(lines):
        if index:
            new_box, new_text = copy.deepcopy(box._element), copy.deepcopy(text._element)
            box._element.addprevious(new_box)
            text._element.addprevious(new_text)
            shapes = {s._element: s for s in slide.shapes}
            row_box, row_text = shapes[new_box], shapes[new_text]
        else:
            row_box, row_text = box, text
        y = top + index * pitch
        place(row_box, top=y, height=box_height)
        place(row_text, top=y + text_offset)
        set_text(row_text, line, size=size)


def build(group: str) -> Path:
    c = CONTENT
    prs = Presentation(TEMPLATE)
    s1, s2, s3, s4, s5 = (prs.slides[i] for i in range(5))

    # 1. title
    set_text(find(s1, "Project title"), c["project"])
    set_text(find(s1, "Group"), f"GROUP {group}  ·  {c['group_name']}")
    set_text(find(s1, "University"), c["university"])
    remove(find(s1, "File note"))

    # 2. introduction and problem
    set_text(find(s2, "Project name field text"), c["project_line"])
    set_text(find(s2, "Team members field text"), c["members"], size=13)
    set_text(next(s for s in s2.shapes if s.name.startswith("Label CASE CHOSEN")), "CASE CHOSEN")
    remove(find(s2, "Case chip 2"))
    remove(find(s2, "Case chip 3"))
    for prompt, field, top, text in (("THE CHALLENGE YOU TACKLE prompt", "The Challenge You Tackle field", 4.07, c["challenge"]),
                                     ("WHY IT MATTERS prompt", "Why It Matters field", 5.99, c["why"])):
        remove(find(s2, prompt))
        place(find(s2, field), top=top, height=0.93)
        place(find(s2, field + " text"), top=top + 0.05, height=0.83)
        set_text(find(s2, field + " text"), text, size=11)

    # 3. solution and features
    remove(find(s3, "YOUR SOLUTION prompt"))
    place(find(s3, "Solution field"), top=4.16, height=2.68)
    place(find(s3, "Solution field text"), top=4.22, height=2.56)
    set_text(find(s3, "Solution field text"), c["solution"], size=11)
    remove(find(s3, "KEY FEATURES & FUNCTIONALITY prompt"))
    visual = find(s3, "Visual placeholder")
    picture_width = 5.3
    s3.shapes.add_picture(str(SCREENSHOT), Inches(6.33 + (5.81 - picture_width) / 2), Inches(4.14),
                          width=Inches(picture_width))
    place(visual, top=6.6, height=0.3)
    visual.fill.background()
    visual.line.fill.background()
    set_text(visual, c["features"], size=10)
    visual.text_frame.paragraphs[0].runs[0].font.bold = False

    # 4. technical stack and implementation
    remove(find(s4, "CORE TECHNOLOGIES & RATIONALE prompt"))
    remove(find(s4, "IMPLEMENTATION CHALLENGES prompt"))
    clone_rows(s4, "Core Technologies & Rationale row 1", "Core Technologies & Rationale row 1 text",
               c["tech"], top=4.16, pitch=0.54, box_height=0.48, size=10.5)
    clone_rows(s4, "Implementation Challenges row 1", "Implementation Challenges row 1 text",
               c["challenges"], top=4.16, pitch=0.54, box_height=0.48, size=10.5)

    # 5. demo and impact
    remove(find(s5, "DEMO prompt"))
    place(find(s5, "Demo field"), top=4.16, height=1.86)
    place(find(s5, "Demo field text"), top=4.22, height=1.74)
    set_text(find(s5, "Demo field text"), c["demo"], size=12)
    set_text(find(s5, "Demo link field text"), [text for text, _ in c["links"]], size=11,
             links=[url for _, url in c["links"]])
    place(find(s5, "Demo link field text"), top=6.17, height=0.62)
    remove(find(s5, "IMPACT prompt"))
    place(find(s5, "Immediate impact label"), top=4.16)
    place(find(s5, "Immediate impact field"), top=4.48, height=1.06)
    place(find(s5, "Immediate impact field text"), top=4.52, height=0.98)
    set_text(find(s5, "Immediate impact field text"), c["immediate"], size=11)
    place(find(s5, "Potential future impact label"), top=5.66)
    place(find(s5, "Potential future impact field"), top=5.98, height=0.99)
    place(find(s5, "Potential future impact field text"), top=6.02, height=0.91)
    set_text(find(s5, "Potential future impact field text"), c["future"], size=11)

    out = ROOT / "deliverables" / f"Group {group} - Al Ain University.pptx"
    prs.save(out)
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--group", default="NUMBER", help="your group number")
    print(build(parser.parse_args().group))
