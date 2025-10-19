import os
from flask import Flask, render_template, request, redirect, url_for, flash
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_login import LoginManager, login_user, logout_user, current_user, login_required, UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
from database import init_db, db, User, Room, Game, GamePlayer, leaderboard

app = Flask(__name__, template_folder="templates", static_folder="static",
            instance_relative_config=True)

app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY","dev-secret")
init_db(app)


os.makedirs(app.instance_path, exist_ok=True)

with app.app_context():
    db.create_all()
    # сиды
    from database import Room
    if not Room.query.filter_by(code="mafia").first():
        db.session.add(Room(code="mafia", title="Mafia Main Room"))
        db.session.commit()


with app.app_context():
    db.create_all()
    if not Room.query.filter_by(code="mafia").first():
        db.session.add(Room(code="mafia", title="Mafia Main Room"))
        db.session.commit()

login_manager = LoginManager(app)
login_manager.login_view = "login"

class LoginUser(UserMixin):
    def __init__(self, u: User):
        self.id = str(u.id)
        self.username = u.username

@login_manager.user_loader
def load_user(user_id):
    u = db.session.get(User, int(user_id))
    return LoginUser(u) if u else None

socketio = SocketIO(app, cors_allowed_origins="*", manage_session=True)

MAX_SLOTS = 12
rooms_state = {}
rooms_mod = {}

def _get_free_slot_from(room_code, allowed_slots):
    used = {meta["slot"] for meta in rooms_state.get(room_code, {}).values()}
    for slot in allowed_slots:
        if slot not in used:
            return slot
    return None

@app.route("/")
def index():
    return render_template("index.html", default_room="mafia")

@app.route("/login", methods=["GET","POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username","").strip()
        password = request.form.get("password","")
        u = User.query.filter_by(username=username).first()
        if not u or not check_password_hash(u.password_hash, password):
            flash("Неверное имя пользователя или пароль", "error")
            return redirect(url_for("login"))
        u.last_login_at = datetime.utcnow()
        db.session.commit()
        login_user(LoginUser(u))
        return redirect(url_for("index"))
    return render_template("login.html")

@app.route("/register", methods=["GET","POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username","").strip()
        password = request.form.get("password","")
        if not username or not password:
            flash("Укажите имя и пароль", "error"); return redirect(url_for("register"))
        if User.query.filter_by(username=username).first():
            flash("Имя уже занято", "error"); return redirect(url_for("register"))
        ph = generate_password_hash(password)
        u = User(username=username, password_hash=ph)
        db.session.add(u)
        db.session.commit()
        flash("Регистрация завершена, войдите.", "ok")
        return redirect(url_for("login"))
    return render_template("register.html")

@app.route("/logout")
def logout():
    logout_user()
    return redirect(url_for("index"))

@app.route("/stats")
def stats():
    board = leaderboard(db)
    return render_template("stats.html", board=board)

@socketio.on("join-room")
def on_join_room(data):
    room_code = data.get("roomId", "mafia")
    role = (data.get("role") or "player").lower()  # "player" | "host"

    if not current_user.is_authenticated:
        emit("auth-required", {"message": "Войдите в систему"})
        return

    join_room(room_code)
    rooms_state.setdefault(room_code, {})

    # если уже в комнате — просто вернуть свой слот
    if request.sid in rooms_state[room_code]:
        meta = rooms_state[room_code][request.sid]
        emit("joined", {"selfId": request.sid, "slot": meta["slot"]})
        return

    # выбор слота по роли
    if role == "host":
        free_slot = _get_free_slot_from(room_code, [12])
        if free_slot is None:
            emit("host-slot-busy")  # сообщим клиенту и ничего не меняем
            return
    else:
        free_slot = _get_free_slot_from(room_code, list(range(1, 12)))
        if free_slot is None:
            emit("room-full", {"message": "Комната заполнена (нет свободных слотов для игроков)"})
            return

    name = current_user.username
    rooms_state[room_code][request.sid] = {
        "name": name,
        "slot": free_slot,
        "user_id": int(current_user.id),
        "role": role,
    }

    # список уже присутствующих для вновь подключившегося
    peers = [
        {"sid": sid, "name": meta["name"], "slot": meta["slot"]}
        for sid, meta in rooms_state[room_code].items() if sid != request.sid
    ]
    emit("joined", {"selfId": request.sid, "slot": free_slot, "peers": peers})

    # оповестим остальных
    emit("peer-joined", {"sid": request.sid, "name": name, "slot": free_slot},
         room=room_code, include_self=False)

    emit("mod-state", {"bySlot": rooms_mod.get(room_code, {})}, to=request.sid)

@socketio.on("leave-room")
def on_leave_room(data):
    room_code = data.get("roomId","mafia")
    leave_room(room_code)
    cleanup_peer(room_code, request.sid)

def cleanup_peer(room_code, sid):
    room = rooms_state.get(room_code)
    if not room: return
    if sid in room:
        meta = room.pop(sid)
        emit("peer-left", {"sid": sid, "slot": meta["slot"]}, room=room_code, include_self=False)

        if rooms_mod.get(room_code) and meta["slot"] in rooms_mod[room_code]:
            rooms_mod[room_code].pop(meta["slot"], None)
            emit("mod-state", {"bySlot": rooms_mod[room_code]}, room=room_code)
    if not room: rooms_state.pop(room_code, None)

@socketio.on("webrtc-offer")
def on_offer(data):
    emit("webrtc-offer", {"from": data.get("from"), "sdp": data.get("sdp")}, to=data.get("target"))

@socketio.on("webrtc-answer")
def on_answer(data):
    emit("webrtc-answer", {"from": data.get("from"), "sdp": data.get("sdp")}, to=data.get("target"))

@socketio.on("webrtc-ice")
def on_ice(data):
    emit("webrtc-ice", {"from": data.get("from"), "candidate": data.get("candidate")}, to=data.get("target"))

@socketio.on("disconnect")
def on_disconnect():
    for room_code in list(rooms_state.keys()):
        if request.sid in rooms_state[room_code]:
            cleanup_peer(room_code, request.sid)



@socketio.on("moderate")
def on_moderate(data):
    room_code = data.get("roomId", "mafia")
    slot = int(data.get("slot", 0))
    action = (data.get("action") or "").lower()  # "vote" | "expelled" | "killed" | "clear"

    room = rooms_state.get(room_code, {})
    me = room.get(request.sid)
    if not me:
        return
    # Только ведущий (роль host и слот 12)
    if me.get("role") != "host" or me.get("slot") != 12:
        emit("not-authorized", {"action": "moderate"})
        return

    # Обновим состояние
    if room_code not in rooms_mod:
        rooms_mod[room_code] = {}
    if action == "clear":
        rooms_mod[room_code].pop(slot, None)
    else:
        rooms_mod[room_code][slot] = action  # сохраняем один статус на слот

    # Разошлём всем
    emit("mod-state", {"bySlot": rooms_mod[room_code]}, room=room_code)



# if __name__ == "__main__":
#     socketio.run(app, debug=True)

if __name__ == "__main__":
    import eventlet
    import eventlet.wsgi
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
