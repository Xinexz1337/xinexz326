from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func, case
from datetime import datetime
import os

db = SQLAlchemy()

def init_db(app):

    uri = "sqlite:///E:/projects/xinexz326/mafia.sqlite3"

    app.config["SQLALCHEMY_DATABASE_URI"] = uri
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    db.init_app(app)
    return db




def leaderboard(db):
    U = User
    GP = GamePlayer
    q = (db.session.query(
            U.username.label("username"),
            func.count(GP.id).label("games"),
            func.coalesce(func.sum(case((GP.is_winner == True, 1), else_=0)), 0).label("wins")
        )
        .outerjoin(GP, GP.user_id == U.id)
        .group_by(U.id)
        .order_by(func.count(GP.id).desc()))
    rows = []
    for r in q:
        games = int(r.games or 0)
        wins = int(r.wins or 0)
        winrate = (wins / games * 100.0) if games else 0.0
        rows.append({"username": r.username, "games": games, "wins": wins, "winrate": round(winrate, 1)})
    return rows

class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(30), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True)
    password_hash = db.Column(db.String(255), nullable=False)  # 255 ок для scrypt
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    last_login_at = db.Column(db.DateTime)

class Room(db.Model):
    __tablename__ = "rooms"
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(32), unique=True, nullable=False)
    title = db.Column(db.String(100), nullable=False)

class Game(db.Model):
    __tablename__ = "games"
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False)
    host_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    status = db.Column(db.String(20), default="created", nullable=False)
    started_at = db.Column(db.DateTime)
    ended_at = db.Column(db.DateTime)

class GamePlayer(db.Model):
    __tablename__ = "game_players"
    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(db.Integer, db.ForeignKey("games.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    seat_slot = db.Column(db.Integer)
    role = db.Column(db.String(30))
    alive = db.Column(db.Boolean, default=True, nullable=False)
    is_winner = db.Column(db.Boolean)
    joined_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

def leaderboard(db):
    from sqlalchemy import case
    U = User
    GP = GamePlayer
    q = (db.session.query(
            U.username.label("username"),
            func.count(GP.id).label("games"),
            func.coalesce(func.sum(case((GP.is_winner == True, 1), else_=0)), 0).label("wins")
        )
        .join(GP, GP.user_id == U.id, isouter=True)
        .group_by(U.id)
        .order_by(func.count(GP.id).desc()))
    rows = []
    for r in q:
        games = int(r.games or 0)
        wins = int(r.wins or 0)
        winrate = (wins / games * 100.0) if games else 0.0
        rows.append({"username": r.username, "games": games, "wins": wins, "winrate": round(winrate, 1)})
    return rows
