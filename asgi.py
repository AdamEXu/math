import os

from a2wsgi import WSGIMiddleware
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute

import realtime
from app import app as flask_app

if os.environ.get("FLASK_DEBUG") == "1":
    flask_app.debug = True

wsgi = WSGIMiddleware(flask_app, workers=int(os.environ.get("WSGI_THREADS", "32")))
sockets = Starlette(
    routes=[
        WebSocketRoute("/ws/graphs/{graph_id}", realtime.graph_socket(flask_app)),
        WebSocketRoute("/ws/presence", realtime.presence_socket(flask_app)),
    ]
)


async def app(scope, receive, send):
    if scope["type"] == "http":
        await wsgi(scope, receive, send)
    else:
        await sockets(scope, receive, send)
