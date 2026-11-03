'use strict';

function createUserController({ userService }) {
  return {
    async createGuest(req, res) {
      const { user, temporaryPassword } = await userService.createGuest(req.user, req.valid.body);
      res.set('Cache-Control', 'no-store').status(201).json({
        user,
        temporaryPassword, // shown exactly once; only its hash is stored
        note: 'Give this password to the guest. They must change it at first login.',
      });
    },
    async search(req, res) {
      res.json({ items: await userService.searchCustomers(req.valid.query) });
    },
    async setRole(req, res) {
      res.json(await userService.setRole(req.user, req.valid.params.id, req.valid.body.role));
    },
    async resetPassword(req, res) {
      const { user, temporaryPassword } = await userService.resetPassword(req.user, req.valid.params.id);
      res.set('Cache-Control', 'no-store').json({ user, temporaryPassword });
    },
  };
}

module.exports = { createUserController };
