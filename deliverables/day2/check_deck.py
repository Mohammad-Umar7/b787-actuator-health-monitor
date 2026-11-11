"""Check the Day 2 deck's text: six slides at most, the template's headings, the numbers, "simulated" labelled, no long dashes.

    python deliverables\\day2\\check_deck.py [deck.pptx]
"""
import sys
from pathlib import Path

from pptx import Presentation

path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "Team Maze - Al Ain University.pptx"
deck = Presentation(str(path))
text = " ".join(shape.text_frame.text for slide in deck.slides for shape in slide.shapes if shape.has_text_frame)
movies = sum(1 for slide in deck.slides for shape in slide.shapes if shape.shape_type == 16)
print("slides:", len(deck.slides))
print("embedded videos:", movies)
print("long dashes:", text.count(chr(8212)) + text.count(chr(8211)))
print("'simulated' appears:", text.lower().count("simulated"), "times")
wanted = ["Introduction & Problem", "Solution & Features", "Technical Stack & Implementation", "Demo & Impact", "Thank You",
          "PROJECT NAME", "TEAM MEMBERS", "CASE CHOSEN", "THE CHALLENGE YOU TACKLE", "WHY IT MATTERS", "YOUR SOLUTION", "KEY FEATURES & FUNCTIONALITY",
          "CORE TECHNOLOGIES & RATIONALE", "IMPLEMENTATION CHALLENGES", "DEMO", "IMMEDIATE IMPACT", "POTENTIAL FUTURE IMPACT",
          "0.709", "185 of 187", "110 tests", "184", "167 planned", "17 surprises", "91%", "0.77", "5 weeks", "MISSING INPUT", "TOOL FAILURE",
          "docker compose up --build", "acumain.vercel.app", "Team Maze", "Al Ain University"]
missing = [w for w in wanted if w not in text]
print(f"{len(wanted) - len(missing)} of {len(wanted)} expected phrases found" + (f"; MISSING: {missing}" if missing else ""))
