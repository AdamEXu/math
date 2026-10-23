import os

from flask import Flask, render_template

app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html", api_key=os.environ["DESMOS_API_KEY"])


@app.get("/health")
def health():
    return {"status": "ok"}
