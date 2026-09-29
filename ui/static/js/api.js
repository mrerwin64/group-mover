// Calls to server.py, which forwards them to the C library

async function request(path, body) {
    const options = body === undefined ? {} : {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
    };
    let response;
    try {
        response = await fetch(path, options);
    } catch (e) {
        throw new Error("Can't reach the server; is server.py still running?");
    }
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error(`The server answered ${response.status} without JSON`);
    }
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
    return data;
}

export const api = {
    info: () => request("/api/info"),
    // seeds: list of decimal strings; returns {results: [{seed, status, status_name, status_string, assignments}]}
    solve: (input, seeds) => request("/api/solve", {groups: input.groups, moves: input.moves, seeds}),
    rebuild: () => request("/api/rebuild", {}),
};
