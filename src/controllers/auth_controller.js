'use strict';

/** Controllers read the validated request, call a service and shape the response. No business logic here. */
function createAuthController({ authService }) {
  const noStore = (res) => res.set('Cache-Control', 'no-store'); // responses carry tokens

  return {
    async register(req, res) {
      const { user, token } = await authService.register(req.valid.body);
      noStore(res).status(201).json({ user, token });
    },
    async login(req, res) {
      const { user, token, mustChangePassword } = await authService.login(req.valid.body);
      noStore(res).json({ user, token, mustChangePassword });
    },
    async changePassword(req, res) {
      const { user, token } = await authService.changePassword(req.user.id, req.valid.body);
      noStore(res).json({ user, token }); // the old token stops working, so a fresh one is returned
    },
    async me(req, res) {
      res.json(await authService.getProfile(req.user.id));
    },
  };
}

module.exports = { createAuthController };
