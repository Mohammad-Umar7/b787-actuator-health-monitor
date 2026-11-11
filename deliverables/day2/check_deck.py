"""Check the Day 2 deck's text: six slides at most, the numbers, "simulated" labelled, no long dashes.

    .venv\\Scripts\\python deliverables\\day2\\check_deck.py
"""
from pathlib import Path

from pptx import Presentation

deck = Presentation(str(Path(__file__).resolve().parent / "Team Maze - Al Ain University.pptx"))
text = " ".join(shape.text_frame.text for slide in deck.slides for shape in slide.shapes if shape.has_text_frame)
print("slides:", len(deck.slides))
print("long dashes:", text.count(chr(8212)) + text.count(chr(8211)))
print("'simulated' appears:", text.lower().count("simulated"), "times")
for number in ["0.709", "0.740", "185 of 187", "110", "184 failures", "0 to 7", "167 of 184", "91%", "65% to 79%", "14-day", "0.77", "5 weeks", "docker compose up --build", "acumain.vercel.app"]:
    print(f"  {'ok ' if number in text else 'MISSING'} {number}")
